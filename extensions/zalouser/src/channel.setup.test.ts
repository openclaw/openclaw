import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { withEnvAsync } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import "./zalo-js.test-mocks.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";

const zalouserSetupPlugin = {
  id: "zalouser",
  meta: {
    id: "zalouser",
    label: "ZaloUser",
    selectionLabel: "ZaloUser",
    docsPath: "/channels/zalouser",
    blurb: "Unofficial Zalo personal account connector.",
  },
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
  },
  config: {
    listAccountIds: (cfg: unknown) => listZalouserAccountIds(cfg as never),
    defaultAccountId: (cfg: unknown) => resolveDefaultZalouserAccountId(cfg as never),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveZalouserAccountSync({ cfg, accountId }),
  },
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver({
      channelKey: "zalouser",
      resolvePolicy: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.dmPolicy,
      resolveAllowFrom: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw: string) => raw.trim().replace(/^(zalouser|zlu):/i, ""),
    }),
  },
  setup: zalouserSetupAdapter,
  setupWizard: zalouserSetupWizard,
} as const;

const zalouserSetupGetStatus = createPluginSetupWizardStatus(zalouserSetupPlugin);

describe("zalouser setup plugin", () => {
  it("builds setup status without an initialized runtime", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-setup-"));

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await expect(
          zalouserSetupGetStatus({
            cfg: {},
            accountOverrides: {},
          }),
        ).resolves.toMatchObject({
          channel: "zalouser",
          configured: false,
          statusLines: ["Zalo Personal: needs QR login"],
        });
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
