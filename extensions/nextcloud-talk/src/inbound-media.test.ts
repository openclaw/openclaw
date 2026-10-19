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

function credentialedShareUrl(): string {
  const url = new URL("https://nextcloud.example/s/redacted-token");
  url.username = "user";
  url.password = "password";
  return url.href;
}

function webDavFileIdResponse(fileId: string): Response {
  return new Response(
    `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>${fileId}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
    { status: 207, headers: { "content-type": "application/xml" } },
  );
}

describe("Nextcloud Talk inbound media policy", () => {
  it.each([
    {
      label: "root install",
      baseUrl: "https://nextcloud.example",
      shareUrl: "https://nextcloud.example/s/redacted-token",
    },
    {
      label: "subpath install",
      baseUrl: "https://nextcloud.example/cloud/",
      shareUrl: "https://nextcloud.example/cloud/s/redacted-token",
    },
    {
      label: "root index.php share",
      baseUrl: "https://nextcloud.example",
      shareUrl: "https://nextcloud.example/index.php/s/redacted-token",
    },
    {
      label: "subpath index.php share",
      baseUrl: "https://nextcloud.example/cloud/",
      shareUrl: "https://nextcloud.example/cloud/index.php/s/redacted-token",
    },
    {
      label: "root file link",
      baseUrl: "https://nextcloud.example",
      shareUrl: "https://nextcloud.example/index.php/f/9001",
    },
    {
      label: "subpath file link",
      baseUrl: "https://nextcloud.example/cloud/",
      shareUrl: "https://nextcloud.example/cloud/index.php/f/9001",
    },
    {
      label: "root short file link",
      baseUrl: "https://nextcloud.example",
      shareUrl: "https://nextcloud.example/f/9001",
    },
    {
      label: "subpath short file link",
      baseUrl: "https://nextcloud.example/cloud/",
      shareUrl: "https://nextcloud.example/cloud/f/9001",
    },
  ])("validates the Talk share reference for a $label", (testCase) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: testCase.baseUrl,
        shareUrl: testCase.shareUrl,
        fileName: "receipt 1.pdf",
      }),
    ).toEqual({
      ok: true,
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "receipt 1.pdf",
    });
  });

  it.each([
    { label: "malformed", shareUrl: "not a URL" },
    { label: "non-HTTP", shareUrl: "ftp://nextcloud.example/s/redacted-token" },
    {
      label: "credential-bearing",
      shareUrl: credentialedShareUrl(),
    },
    {
      label: "query-bearing",
      shareUrl: "https://nextcloud.example/s/redacted-token?download=1",
    },
    {
      label: "fragment-bearing",
      shareUrl: "https://nextcloud.example/s/redacted-token#fragment",
    },
    { label: "wrong path", shareUrl: "https://nextcloud.example/other/9001" },
    { label: "extra short file path", shareUrl: "https://nextcloud.example/f/9001/extra" },
    {
      label: "extra share path",
      shareUrl: "https://nextcloud.example/s/redacted-token/extra",
    },
  ])("rejects a $label share link as invalid", ({ shareUrl }) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl,
        fileName: "receipt.pdf",
      }),
    ).toEqual({ ok: false, reason: "media_invalid_link" });
  });

  it.each([
    { label: "scheme", shareUrl: "http://nextcloud.example/s/redacted-token" },
    { label: "hostname", shareUrl: "https://files.example/s/redacted-token" },
    { label: "effective port", shareUrl: "https://nextcloud.example:8443/s/redacted-token" },
  ])("rejects a different $label as an origin mismatch", ({ shareUrl }) => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl,
        fileName: "receipt.pdf",
      }),
    ).toEqual({ ok: false, reason: "media_origin_mismatch" });
  });

  it("sanitizes the untrusted filename before URL derivation", () => {
    expect(
      resolveNextcloudTalkAttachmentReference({
        baseUrl: "https://nextcloud.example",
        shareUrl: "https://nextcloud.example/s/redacted-token",
        fileName: "../evil/re<po|rt?.pdf",
      }),
    ).toEqual({
      ok: true,
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "report.pdf",
    });
  });

  it("resolves the exact room message to an authenticated canonical-UID WebDAV source", async () => {
    const releaseUser = vi.fn(async () => undefined);
    const releaseHistory = vi.fn(async () => undefined);
    const releaseWebDav = vi.fn(async () => undefined);
    const fetchGuarded = mocks.fetchGuarded
      .mockReset()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: { id: "users/alice" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
        release: releaseUser,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ocs: {
              data: [
                {
                  id: 4242,
                  token: "room-token",
                  actorType: "users",
                  actorId: "alice",
                  messageParameters: {
                    file: {
                      type: "file",
                      id: "9001",
                      name: "receipt 1.pdf",
                      size: "2048",
                      path: "Talk/Receipts/receipt 1.pdf",
                      mimetype: "application/pdf",
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: releaseHistory,
      })
      .mockResolvedValueOnce({
        response: webDavFileIdResponse("9001"),
        release: releaseWebDav,
      });

    const result = await resolveNextcloudTalkAuthenticatedMediaSource({
      baseUrl: "https://nextcloud.example/cloud/",
      roomToken: "room-token",
      messageId: "4242",
      senderId: "users/alice",
      attachment: {
        fileId: "9001",
        name: "receipt 1.pdf",
        mimeType: "application/pdf",
        declaredSizeBytes: 2048,
        shareUrl: "https://nextcloud.example/cloud/s/redacted-token",
        hideDownload: false,
      },
      accountConfig: {
        apiUser: "alice@example.com",
        apiPassword: "test-password",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
      reference: {
        ok: true,
        origin: "https://nextcloud.example",
        hostname: "nextcloud.example",
        fileName: "receipt 1.pdf",
      },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://nextcloud.example/cloud/remote.php/dav/files/users%2Falice/Talk/Receipts/receipt%201.pdf",
      origin: "https://nextcloud.example",
      hostname: "nextcloud.example",
      fileName: "receipt 1.pdf",
      authorization: `Basic ${Buffer.from("alice@example.com:test-password").toString("base64")}`,
    });
    expect(fetchGuarded).toHaveBeenCalledTimes(3);
    expect(fetchGuarded.mock.calls.map(([call]) => call.url)).toEqual([
      "https://nextcloud.example/cloud/ocs/v1.php/cloud/user?format=json",
      "https://nextcloud.example/cloud/ocs/v2.php/apps/spreed/api/v1/chat/room-token?lookIntoFuture=0&limit=1&lastKnownMessageId=4242&includeLastKnown=1&setReadMarker=0&noStatusUpdate=1&markNotificationsAsRead=0",
      "https://nextcloud.example/cloud/remote.php/dav/files/users%2Falice/Talk/Receipts/receipt%201.pdf",
    ]);
    for (const [call] of fetchGuarded.mock.calls.slice(0, 2)) {
      expect(call).toEqual(
        expect.objectContaining({
          maxRedirects: 0,
          requireHttps: true,
          policy: {
            allowPrivateNetwork: true,
            hostnameAllowlist: ["nextcloud.example"],
          },
          init: expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({
              Authorization: expect.stringMatching(/^Basic /u),
              "OCS-APIRequest": "true",
            }),
          }),
        }),
      );
    }
    expect(fetchGuarded.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        maxRedirects: 0,
        requireHttps: true,
        init: expect.objectContaining({
          method: "PROPFIND",
          headers: expect.objectContaining({
            Depth: "0",
            Authorization: expect.stringMatching(/^Basic /u),
          }),
        }),
      }),
    );
    expect(releaseUser).toHaveBeenCalledOnce();
    expect(releaseHistory).toHaveBeenCalledOnce();
    expect(releaseWebDav).toHaveBeenCalledOnce();
  });

  it("stops authenticated metadata lookup when the ingress claim is cancelled", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("ingress claim retired");
    const fetchGuarded = mocks.fetchGuarded
      .mockReset()
      .mockImplementationOnce(async () => {
        abortController.abort(abortReason);
        return {
          response: new Response(JSON.stringify({ ocs: { data: { id: "users/alice" } } }), {
            status: 200,
          }),
          finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
          release: vi.fn(async () => undefined),
        };
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: [] } }), { status: 200 }),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: vi.fn(async () => undefined),
      });

    await expect(
      resolveNextcloudTalkAuthenticatedMediaSource({
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
        },
        accountConfig: { apiUser: "alice", apiPassword: "test-password" },
        reference: {
          ok: true,
          origin: "https://nextcloud.example",
          hostname: "nextcloud.example",
          fileName: "receipt.pdf",
        },
        signal: abortController.signal,
      }),
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
      mocks.fetchGuarded
        .mockReset()
        .mockResolvedValueOnce({
          response: new Response(JSON.stringify({ ocs: { data: { id: "alice" } } }), {
            status: 200,
          }),
          finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
          release: vi.fn(async () => undefined),
        })
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              ocs: {
                data: [
                  {
                    id: 4250,
                    token: "room-token",
                    actorType: "users",
                    actorId: "alice",
                    messageType: "voice-message",
                    messageParameters: {
                      file: {
                        type: "file",
                        id: "9010",
                        name: "voice-note.mp3",
                        size: "18351",
                        path: "Talk/voice-note.mp3",
                        mimetype: declaredMimeType,
                        "hide-download": "no",
                      },
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          ),
          finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
          release: vi.fn(async () => undefined),
        })
        .mockResolvedValueOnce({
          response: webDavFileIdResponse("9010"),
          release: vi.fn(async () => undefined),
        });

      const result = await resolveNextcloudTalkAuthenticatedMediaSource({
        baseUrl: "https://nextcloud.example",
        roomToken: "room-token",
        messageId: "4250",
        senderId: "users/alice",
        attachment: {
          fileId: "9010",
          name: "voice-note.mp3",
          mimeType: declaredMimeType,
          declaredSizeBytes: 18_351,
          shareUrl: "https://nextcloud.example/s/redacted-token",
          hideDownload: false,
        },
        accountConfig: { apiUser: "alice", apiPassword: "test-password" },
        reference: {
          ok: true,
          origin: "https://nextcloud.example",
          hostname: "nextcloud.example",
          fileName: "voice-note.mp3",
        },
      });

      expect(result).toEqual(
        expect.objectContaining({
          ok: true,
          sourceModality: "voice",
          ...(expectedOverride ? { contentTypeOverride: expectedOverride } : {}),
        }),
      );
    },
  );

  it("fails closed when API credentials are unavailable", async () => {
    const fetchGuarded = mocks.fetchGuarded.mockReset();
    await expect(
      resolveNextcloudTalkAuthenticatedMediaSource({
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
        },
        accountConfig: {},
        reference: {
          ok: true,
          origin: "https://nextcloud.example",
          hostname: "nextcloud.example",
          fileName: "receipt.pdf",
        },
      }),
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
    { field: "recipient name/path consistency", file: { path: "Talk/other.pdf" } },
  ])("rejects a mismatched $field independently of other metadata", async ({ message, file }) => {
    const fetchGuarded = mocks.fetchGuarded
      .mockReset()
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ocs: { data: { id: "alice" } } }), {
          status: 200,
        }),
        finalUrl: "https://nextcloud.example/ocs/v1.php/cloud/user?format=json",
        release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            ocs: {
              data: [
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
              ],
            },
          }),
          { status: 200 },
        ),
        finalUrl: "https://nextcloud.example/ocs/v2.php/apps/spreed/api/v1/chat/room-token",
        release: vi.fn(async () => undefined),
      });
    const result = await resolveNextcloudTalkAuthenticatedMediaSource({
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
      },
      accountConfig: { apiUser: "alice", apiPassword: "test-password" },
      reference: {
        ok: true,
        origin: "https://nextcloud.example",
        hostname: "nextcloud.example",
        fileName: "receipt.pdf",
      },
    });
    expect(result).toEqual({ ok: false, reason: "media_message_mismatch" });
    expect(fetchGuarded).toHaveBeenCalledTimes(2);
  });

  it.each([
    { webDavId: "9001", accepted: true },
    { webDavId: "9002", accepted: false },
  ])(
    "uses the recipient collision-renamed mount only with matching WebDAV identity ($webDavId)",
    async ({ webDavId, accepted }) => {
      const fetchGuarded = mocks.fetchGuarded
        .mockReset()
        .mockResolvedValueOnce({
          response: Response.json({ ocs: { data: { id: "bob" } } }),
          release: vi.fn(),
        })
        .mockResolvedValueOnce({
          response: Response.json({
            ocs: {
              data: [
                {
                  id: 4242,
                  token: "room-token",
                  actorType: "users",
                  actorId: "alice",
                  messageParameters: {
                    file: {
                      type: "file",
                      id: "9001",
                      name: "receipt (2).pdf",
                      mimetype: "application/pdf",
                      size: "2048",
                      path: "Talk/receipt (2).pdf",
                    },
                  },
                },
              ],
            },
          }),
          release: vi.fn(),
        })
        .mockResolvedValueOnce({ response: webDavFileIdResponse(webDavId), release: vi.fn() });

      const result = await resolveNextcloudTalkAuthenticatedMediaSource({
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
        },
        accountConfig: { apiUser: "bob", apiPassword: "test-password" },
        reference: {
          ok: true,
          origin: "https://nextcloud.example",
          hostname: "nextcloud.example",
          fileName: "receipt.pdf",
        },
      });

      expect(fetchGuarded).toHaveBeenCalledTimes(3);
      expect(fetchGuarded.mock.calls[2]?.[0].url).toBe(
        "https://nextcloud.example/remote.php/dav/files/bob/Talk/receipt%20(2).pdf",
      );
      if (accepted) {
        expect(result).toMatchObject({
          ok: true,
          url: "https://nextcloud.example/remote.php/dav/files/bob/Talk/receipt%20(2).pdf",
        });
      } else {
        expect(result).toEqual({ ok: false, reason: "media_message_mismatch" });
      }
    },
  );
});
