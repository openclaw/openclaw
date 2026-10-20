import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it } from "vitest";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { withNextcloudTalkOutboundFixture as withTalk } from "./outbound-media.test-harness.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const send = (ctx: ChannelMessageSendMediaContext) =>
  nextcloudTalkPlugin.message!.send!.media!(ctx);

it.each(["lost-ack", "cancelled", "identity-failure"] as const)(
  "removes the committed unshared file after %s",
  async (failure) => {
    await withTalk(async (fixture) => {
      const controller = new AbortController();
      const files = new Map<string, Buffer>();
      fixture.respond = (request, response) => {
        if (request.method === "PUT") {
          expect(request.ifNoneMatch).toBe("*");
          files.set(request.url.pathname, request.body);
          if (failure === "cancelled") {
            controller.abort(new Error("upload cancelled after commit"));
          }
          if (failure === "identity-failure") {
            response.writeHead(201);
            response.end();
          } else {
            response.destroy();
          }
          return true;
        }
        if (request.method === "PROPFIND") {
          response.writeHead(500);
          response.end();
          return true;
        }
        if (request.method === "DELETE") {
          for (const key of files.keys()) {
            if (key.startsWith(request.url.pathname + "/")) {
              files.delete(key);
            }
          }
          response.writeHead(204);
          response.end();
          return true;
        }
        return false;
      };
      await expect(send({ ...fixture.ctx, signal: controller.signal })).rejects.toThrow();
      expect(files.size).toBe(0);
      expect(fixture.requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
      expect(fixture.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
      expect(fixture.requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
    });
  },
);

it("does not delete a pre-existing file after create-only PUT returns 412", async () => {
  await withTalk(async (fixture) => {
    const existing = Buffer.from("another upload");
    const files = new Map<string, Buffer>();
    fixture.respond = (request, response) => {
      if (request.method === "PUT") {
        expect(request.ifNoneMatch).toBe("*");
        files.set(request.url.pathname, existing);
        response.writeHead(412);
        response.end();
        return true;
      }
      if (request.method === "DELETE") {
        files.delete(request.url.pathname);
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    };
    await expect(send(fixture.ctx)).rejects.toThrow(/upload failed \(412\)/u);
    expect([...files.values()]).toEqual([existing]);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});

it("preserves pre-existing data when the create-only rejection response is lost", async () => {
  await withTalk(async (fixture) => {
    const existing = Buffer.from("pre-existing unrelated file");
    const files = new Map<string, Buffer>();
    fixture.respond = (request, response) => {
      if (request.method === "MKCOL" && !request.url.pathname.endsWith("/OpenClaw")) {
        // A pre-existing child implies its parent collection already exists.
        files.set(request.url.pathname + "/existing.pdf", existing);
        response.writeHead(405);
        response.end();
        return true;
      }
      if (request.method === "PUT") {
        files.set(request.url.pathname, existing);
        // The server rejected this create-only PUT with 412, but no ack arrives.
        response.destroy();
        return true;
      }
      if (request.method === "DELETE") {
        for (const key of files.keys()) {
          if (key === request.url.pathname || key.startsWith(request.url.pathname + "/")) {
            files.delete(key);
          }
        }
        response.writeHead(204);
        response.end();
        return true;
      }
      return false;
    };
    await expect(send(fixture.ctx)).rejects.toThrow();
    expect([...files.values()]).toEqual([existing]);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});

it.each([
  { name: "界".repeat(70) + ".pdf", suffix: ".pdf", stem: "界".repeat(66) },
  { name: "😀".repeat(55) + ".png", suffix: ".png", stem: "😀".repeat(50) },
  { name: "a".repeat(190) + ".pdf", suffix: ".pdf", stem: "a".repeat(190) },
  { name: "界." + "語".repeat(70), suffix: "." + "語".repeat(66), stem: "界" },
])(
  "fits the complete UTF-8 upload component while preserving the extension: $name",
  async ({ name, suffix, stem }) => {
    await withTalk(async (fixture) => {
      const mediaUrl = path.join(fixture.directory, name);
      await writeFile(mediaUrl, fixture.bytes);
      fixture.respond = (request, response) => {
        if (request.method !== "PUT") {
          return false;
        }
        const component = decodeURIComponent(request.url.pathname.split("/").at(-1)!);
        // Model the server's complete-component byte limit, not JS string length.
        if (Buffer.byteLength(component) > 250) {
          response.writeHead(400);
          response.end();
          return true;
        }
        return false;
      };
      await expect(send({ ...fixture.ctx, mediaUrl })).resolves.toMatchObject({ messageId: "42" });
      const upload = fixture.requests.find(({ method }) => method === "PUT")!;
      const component = decodeURIComponent(upload.url.pathname.split("/").at(-1)!);
      expect(Buffer.byteLength(component)).toBeLessThanOrEqual(250);
      expect(component).toMatch(/^openclaw-[0-9a-f-]{36}-/u);
      expect(component.slice(46)).toBe(stem + suffix);
    });
  },
);

it.each(["user", "history"] as const)(
  "does not suppress a human file when %s lookup fails",
  async (failure) => {
    await withTalk(async (fixture) => {
      const { isNextcloudTalkOutboundFileEcho } = await import("./outbound-media.js");
      const account = resolveNextcloudTalkAccount({
        cfg: fixture.ctx.cfg as CoreConfig,
        accountId: "work",
      });
      fixture.respond = (request, response) => {
        if (
          (failure === "user" && request.url.pathname.endsWith("/cloud/user")) ||
          (failure === "history" && request.url.pathname.includes("/chat/"))
        ) {
          response.writeHead(503);
          response.end();
          return true;
        }
        return false;
      };
      const message: NextcloudTalkInboundMessage = {
        messageId: "43",
        roomToken: "allowed",
        roomName: "Fixture",
        senderId: "users/canonical-user",
        senderName: "Human",
        text: "Shared report",
        mediaType: "text/plain",
        timestamp: Date.now(),
        isGroupChat: true,
        attachment: {
          fileId: "83",
          name: "openclaw-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-report.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: fixture.bytes.length,
          shareUrl: "",
          hideDownload: false,
        },
      };
      await expect(isNextcloudTalkOutboundFileEcho({ account, message })).resolves.toBe(false);
    });
  },
);
