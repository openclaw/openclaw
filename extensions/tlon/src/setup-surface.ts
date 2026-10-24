import { createSetupTranslator, splitSetupEntries } from "openclaw/plugin-sdk/setup-runtime";
import { applyTlonSetupConfig, createTlonSetupWizardBase } from "./setup-core.js";
import { normalizeShip } from "./targets.js";
import { resolveTlonAccount } from "./types.js";
import { isBlockedUrbitHostname, validateUrbitBaseUrl } from "./urbit/base-url.js";

const t = createSetupTranslator();

export const tlonSetupWizard = createTlonSetupWizardBase(async ({ cfg, accountId, prompter }) => {
  let next = cfg;
  const resolved = resolveTlonAccount(next, accountId);
  const validatedUrl = validateUrbitBaseUrl(resolved.url ?? "");
  if (!validatedUrl.ok) {
    throw new Error(`Invalid URL: ${validatedUrl.error}`);
  }

  let dangerouslyAllowPrivateNetwork = resolved.dangerouslyAllowPrivateNetwork ?? false;
  if (isBlockedUrbitHostname(validatedUrl.hostname)) {
    dangerouslyAllowPrivateNetwork = await prompter.confirm({
      message: t("wizard.tlon.privateNetworkPrompt"),
      initialValue: dangerouslyAllowPrivateNetwork,
    });
    if (!dangerouslyAllowPrivateNetwork) {
      throw new Error("Refusing private/internal ship URL without explicit network opt-in");
    }
  }
  next = applyTlonSetupConfig({
    cfg: next,
    accountId,
    input: { dangerouslyAllowPrivateNetwork },
  });

  for (const field of ["groupChannels", "dmAllowlist"] as const) {
    const groups = field === "groupChannels";
    const current = resolved[field];
    const wantsEntries = await prompter.confirm({
      message: t(groups ? "wizard.tlon.addGroupsPrompt" : "wizard.tlon.restrictDmsPrompt"),
      initialValue: current.length > 0,
    });
    if (wantsEntries) {
      const entry = await prompter.text({
        message: t(groups ? "wizard.tlon.groupChannelsPrompt" : "wizard.tlon.dmAllowlistPrompt"),
        placeholder: groups ? "chat/~host-ship/general, chat/~host-ship/support" : "~zod, ~nec",
        initialValue: current.join(", ") || undefined,
      });
      const entries = splitSetupEntries(entry ?? "");
      next = applyTlonSetupConfig({
        cfg: next,
        accountId,
        input: { [field]: groups ? entries : entries.map((ship) => normalizeShip(ship)) },
      });
    }
  }

  const autoDiscoverChannels = await prompter.confirm({
    message: t("wizard.tlon.autoDiscoveryPrompt"),
    initialValue: resolved.autoDiscoverChannels ?? true,
  });
  next = applyTlonSetupConfig({
    cfg: next,
    accountId,
    input: { autoDiscoverChannels },
  });

  return { cfg: next };
});
