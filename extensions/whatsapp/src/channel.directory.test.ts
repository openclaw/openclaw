import type { OpenClawConfig } from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, it } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/extensions/directory.ts";
import { whatsappPlugin } from "./channel.js";

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          authDir: "/tmp/wa-auth",
          allowFrom: [
            "whatsapp:+15551230001",
            "15551230002@s.whatsapp.net",
            "120363999999999999@g.us",
          ],
          groups: {
            "120363111111111111@g.us": {},
            "120363222222222222@g.us": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(whatsappPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "+15551230001" },
        { kind: "user", id: "+15551230002" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "120363111111111111@g.us" },
        { kind: "group", id: "120363222222222222@g.us" },
      ]),
    );
  });
});
