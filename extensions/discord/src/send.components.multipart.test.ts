import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags } from "discord-api-types/v10";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import type { DiscordComponentMessageSpec } from "./components.js";
import { sendDiscordComponentMessage } from "./send.components.js";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

const FILE_CONTENT = "%PDF-1.4\nDiscord attachment filename proof\n%%EOF\n";
it.each<
  [
    label: string,
    declaredName: string | undefined,
    filename: string | undefined,
    componentsV2: boolean,
    expectedName: string,
    textBlocks?: string[],
  ]
>([
  ["classic blank", "report.pdf", "  ", false, "report.pdf"],
  ["classic override", "report.pdf", " operator.pdf ", false, "operator.pdf"],
  ["component declared", "report.pdf", undefined, true, "report.pdf"],
  ["component repeats", undefined, undefined, true, "source.pdf", ["Step A", "Step B", "Step A"]],
])(
  "preserves %s in the multipart upload",
  async (_label, declaredName, filename, componentsV2, expectedName, textBlocks) => {
    await withTempHome(async (home) => {
      const mediaRoot = await fs.realpath(home);
      const mediaPath = path.join(mediaRoot, "source.pdf");
      await fs.writeFile(mediaPath, FILE_CONTENT);
      const loopback = await createDiscordLoopbackRest();
      try {
        const blocks: NonNullable<DiscordComponentMessageSpec["blocks"]> = (textBlocks ?? []).map(
          (text) => ({ type: "text", text }),
        );
        if (declaredName) {
          blocks.push({ type: "file", file: `attachment://${declaredName}` });
        }
        const result = await sendDiscordComponentMessage(
          "channel:789",
          {
            text: textBlocks ? "" : "See attached report",
            blocks,
            ...(componentsV2 ? { container: { accentColor: 0x123456 } } : {}),
          },
          {
            cfg: { channels: { discord: { token: "test-token" } } },
            token: "test-token",
            rest: loopback.rest,
            mediaUrl: mediaPath,
            mediaLocalRoots: [mediaRoot],
            filename,
          },
        );
        expect(result.messageId).toBe("loopback-message");
        const uploads = loopback.requests.filter((request) => request.method === "POST");
        expect(uploads).toHaveLength(1);
        const upload = uploads[0];
        expect(upload?.path).toBe("/v10/channels/789/messages");
        expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
        const form = await new Response(upload?.body, {
          headers: { "content-type": upload?.contentType ?? "" },
        }).formData();
        const file = form.get("files[0]");
        if (!file || typeof file === "string") {
          throw new Error("Missing files[0]");
        }
        const payloadJson = form.get("payload_json");
        if (typeof payloadJson !== "string") {
          throw new Error("Missing string payload_json");
        }
        const payload: {
          attachments?: Array<{ id: number; filename: string }>;
          flags?: number;
          components?: Array<{ components?: Array<{ content?: string }> }>;
        } = JSON.parse(payloadJson);
        expect(await file.text()).toBe(FILE_CONTENT);
        expect(file.type).toBe("application/pdf");
        expect(file.name).toBe(expectedName);
        expect(payload.attachments).toEqual([{ id: 0, filename: expectedName }]);
        expect(Boolean((payload.flags ?? 0) & MessageFlags.IsComponentsV2)).toBe(componentsV2);
        if (textBlocks) {
          expect(
            payload.components?.[0]?.components
              ?.flatMap((component) => (component.content ? [component.content] : []))
              .join("\n\n"),
          ).toBe("Step A\n\nStep B\n\nStep A");
        }
      } finally {
        await loopback.close();
      }
    });
  },
);
