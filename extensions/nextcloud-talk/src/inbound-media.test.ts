import { describe, expect, it, vi } from "vitest";
import {
  resolveNextcloudTalkAttachmentReference,
  resolveNextcloudTalkAuthenticatedMediaSource,
} from "./inbound-media.js";

const mocks = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return { ...actual, fetchWithSsrFGuard: mocks.fetchGuarded };
});

function webDavFileIdResponse(fileId: string, status = 207): Response {
  return new Response(
    `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>${fileId}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

function reference(fileName = "receipt.pdf") {
  return {
    ok: true as const,
    origin: "https://nextcloud.example",
    hostname: "nextcloud.example",
    fileName,
  };
}

type MediaParams = Parameters<typeof resolveNextcloudTalkAuthenticatedMediaSource>[0];
function mediaParams({
  attachment,
  ...overrides
}: Partial<Omit<MediaParams, "attachment">> & {
  attachment?: Partial<MediaParams["attachment"]>;
} = {}): MediaParams {
  return {
    baseUrl: "https://nextcloud.example",
    roomToken: "room-token",
    messageId: "4242",
    senderId: "users/alice",
    attachment: {
      fileId: "9001",
      name: "receipt.pdf",
      mimeType: "application/pdf",
      declaredSizeBytes: 2048,
      shareUrl: "https://nextcloud.example/s/redacted-token",
      hideDownload: false,
      ...attachment,
    },
    accountConfig: { apiUser: "alice", apiPassword: "test-password" },
    reference: reference(),
    ...overrides,
  };
}

function history(file: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return [
    {
      id: 4242,
      token: "room-token",
      actorType: "users",
      actorId: "alice",
      ...message,
      messageParameters: {
        file: {
          type: "file",
          id: "9001",
          name: "receipt.pdf",
          mimetype: "application/pdf",
          size: "2048",
          path: "Talk/receipt.pdf",
          ...file,
        },
      },
    },
  ];
}

function ocsResponse(data: unknown, release = vi.fn(async () => undefined)) {
  return { response: Response.json({ ocs: { data } }), release };
}

function mockLookups(messages = history(), user = "alice", fileId = "9001", status = 207) {
  const releases = Array.from({ length: 3 }, () => vi.fn(async () => undefined));
  const fetchGuarded = mocks.fetchGuarded
    .mockReset()
    .mockResolvedValueOnce(ocsResponse({ id: user }, releases[0]))
    .mockResolvedValueOnce(ocsResponse(messages, releases[1]))
    .mockResolvedValueOnce({
      response: webDavFileIdResponse(fileId, status),
      release: releases[2],
    });
  return { fetchGuarded, releases };
}

function attachmentReference(
  shareUrl: string,
  fileName = "receipt.pdf",
  baseUrl = "https://nextcloud.example",
) {
  return resolveNextcloudTalkAttachmentReference({ baseUrl, shareUrl, fileName });
}

describe("Nextcloud Talk inbound media policy", () => {
  it.each([
    ["root install", "", "s/redacted-token"],
    ["subpath index.php share", "/cloud/", "index.php/s/redacted-token"],
    ["root file link", "", "index.php/f/9001"],
    ["subpath short file link", "/cloud/", "f/9001"],
  ])("validates the Talk share reference for a %s", (_label, basePath, route) => {
    expect(
      attachmentReference(
        `https://nextcloud.example${basePath || "/"}${route}`,
        "receipt 1.pdf",
        `https://nextcloud.example${basePath}`,
      ),
    ).toEqual(reference("receipt 1.pdf"));
  });

  it.each([
    ["malformed", "not a URL"],
    ["non-HTTP", "ftp://nextcloud.example/s/redacted-token"],
    ["credential-bearing", "https://user:password@nextcloud.example/s/redacted-token"],
    ["query-bearing", "https://nextcloud.example/s/redacted-token?download=1"],
    ["fragment-bearing", "https://nextcloud.example/s/redacted-token#fragment"],
    ["wrong path", "https://nextcloud.example/other/9001"],
    ["extra share path", "https://nextcloud.example/s/redacted-token/extra"],
  ])("rejects a %s share link as invalid", (_label, shareUrl) => {
    expect(attachmentReference(shareUrl)).toEqual({ ok: false, reason: "media_invalid_link" });
  });

  it.each([
    { label: "scheme", shareUrl: "http://nextcloud.example/s/redacted-token" },
    { label: "hostname", shareUrl: "https://files.example/s/redacted-token" },
    { label: "effective port", shareUrl: "https://nextcloud.example:8443/s/redacted-token" },
  ])("rejects a different $label as an origin mismatch", ({ shareUrl }) => {
    expect(attachmentReference(shareUrl)).toEqual({ ok: false, reason: "media_origin_mismatch" });
  });

  it("sanitizes the untrusted filename before URL derivation", () => {
    expect(
      attachmentReference("https://nextcloud.example/s/redacted-token", "../evil/re<po|rt?.pdf"),
    ).toEqual(reference("report.pdf"));
  });

  it("stops authenticated metadata lookup when the ingress claim is cancelled", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    const fetchGuarded = mocks.fetchGuarded
      .mockReset()
      .mockImplementationOnce(async () => {
        abortController.abort(abortReason);
        return ocsResponse({ id: "users/alice" });
      })
      .mockResolvedValueOnce(ocsResponse([]));

    await expect(
      resolveNextcloudTalkAuthenticatedMediaSource(
        mediaParams({
          signal: abortController.signal,
        }),
      ),
    ).rejects.toBe(abortReason);

    expect(fetchGuarded).toHaveBeenCalledOnce();
    expect(fetchGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
  });

  it.each([
    { declaredMimeType: "audio/mpeg", expectedOverride: undefined },
    { declaredMimeType: "video/mp4", expectedOverride: "audio/mp4" },
  ])(
    "preserves authenticated native voice intent declared as $declaredMimeType",
    async ({ declaredMimeType, expectedOverride }) => {
      mockLookups(
        history(
          { mimetype: declaredMimeType, "hide-download": "no" },
          { messageType: "voice-message" },
        ),
      );

      const result = await resolveNextcloudTalkAuthenticatedMediaSource(
        mediaParams({ attachment: { mimeType: declaredMimeType } }),
      );

      expect(result).toMatchObject({
        ok: true,
        sourceModality: "voice",
        ...(expectedOverride ? { contentTypeOverride: expectedOverride } : {}),
      });
    },
  );

  it("fails closed when API credentials are unavailable", async () => {
    const fetchGuarded = mocks.fetchGuarded.mockReset();
    await expect(
      resolveNextcloudTalkAuthenticatedMediaSource(mediaParams({ accountConfig: {} })),
    ).resolves.toEqual({ ok: false, reason: "media_auth_unavailable" });
    expect(fetchGuarded).not.toHaveBeenCalled();
  });

  it.each([
    { field: "actor", message: { actorId: "mallory" } },
    { field: "message ID", message: { id: 4243 } },
    { field: "room", message: { token: "another-room" } },
    { field: "file ID", file: { id: "9002" } },
    { field: "MIME", file: { mimetype: "text/plain" } },
    { field: "size", file: { size: "2049" } },
    { field: "download restriction", file: { "hide-download": "yes" } },
    { field: "path traversal", file: { path: "Talk/../receipt.pdf" } },
    { field: "control-bearing folder", file: { path: "Talk/unsafe\u0000/receipt.pdf" } },
    { field: "recipient name/path consistency", file: { path: "Talk/other.pdf" } },
  ])("rejects a mismatched $field independently of other metadata", async ({ message, file }) => {
    const fetchGuarded = mocks.fetchGuarded
      .mockReset()
      .mockResolvedValueOnce(ocsResponse({ id: "alice" }))
      .mockResolvedValueOnce(ocsResponse(history(file, message)));
    const result = await resolveNextcloudTalkAuthenticatedMediaSource(mediaParams());
    expect(result).toEqual({ ok: false, reason: "media_message_mismatch" });
    expect(fetchGuarded).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["9001", 207, undefined],
    ["9002", 207, { ok: false, reason: "media_message_mismatch" }],
    ["9001", 200, { ok: false, reason: "media_fetch_failed", status: 200 }],
    ["9001", 404, { ok: false, reason: "media_unavailable", status: 404 }],
  ] as const)(
    "uses the recipient collision-renamed mount only with matching WebDAV identity (%s/%s)",
    async (webDavId, status, failure) => {
      const { fetchGuarded, releases } = mockLookups(
        history({ name: "receipt (2).pdf", path: "Talk/Receipts/receipt (2).pdf" }),
        "users/bob",
        webDavId,
        status,
      );

      const result = await resolveNextcloudTalkAuthenticatedMediaSource(
        mediaParams({
          baseUrl: "https://nextcloud.example/cloud/",
          accountConfig: {
            apiUser: "bob@example.com",
            apiPassword: "test-password",
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        }),
      );

      expect(fetchGuarded).toHaveBeenCalledTimes(3);
      const url =
        "https://nextcloud.example/cloud/remote.php/dav/files/users%2Fbob/Talk/Receipts/receipt%20(2).pdf";
      expect(fetchGuarded.mock.calls[2]?.[0].url).toBe(url);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
      if (!failure) {
        expect(result).toEqual({
          ...reference(),
          url,
          authorization: `Basic ${Buffer.from("bob@example.com:test-password").toString("base64")}`,
        });
        expect(fetchGuarded.mock.calls[1]?.[0].url).toBe(
          "https://nextcloud.example/cloud/ocs/v2.php/apps/spreed/api/v1/chat/room-token?lookIntoFuture=0&limit=1&lastKnownMessageId=4242&includeLastKnown=1&setReadMarker=0&noStatusUpdate=1&markNotificationsAsRead=0",
        );
        for (const [index, [call]] of fetchGuarded.mock.calls.entries()) {
          expect(call).toMatchObject({
            maxRedirects: 0,
            requireHttps: true,
            init: {
              method: index === 2 ? "PROPFIND" : "GET",
              headers: {
                Authorization: expect.stringMatching(/^Basic /u),
                ...(index === 2 ? { Depth: "0" } : { "OCS-APIRequest": "true" }),
              },
            },
          });
          expect(call.policy).toEqual({
            allowPrivateNetwork: true,
            hostnameAllowlist: ["nextcloud.example"],
          });
        }
      } else {
        expect(result).toEqual(failure);
      }
    },
  );
});
