import path from "node:path";
import { loginWeb } from "../../../src/channel-web.js";
import {
  normalizeAllowFromEntries,
  resolveAccountIdForConfigure,
  resolveOnboardingAccountId,
  splitOnboardingEntries
} from "../../../src/channels/plugins/onboarding/helpers.js";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import { mergeWhatsAppConfig } from "../../../src/config/merge-config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { normalizeE164, pathExists } from "../../../src/utils.js";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAuthDir
} from "./accounts.js";
const channel = "whatsapp";
function setWhatsAppDmPolicy(cfg, dmPolicy) {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}
function setWhatsAppAllowFrom(cfg, allowFrom) {
  return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}
function setWhatsAppSelfChatMode(cfg, selfChatMode) {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}
async function detectWhatsAppLinked(cfg, accountId) {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}
async function promptWhatsAppOwnerAllowFrom(params) {
  const { prompter, existingAllowFrom } = params;
  await prompter.note(
    "We need the sender/owner number so OpenClaw can allowlist you.",
    "WhatsApp number"
  );
  const entry = await prompter.text({
    message: "Your personal WhatsApp number (the phone you will message from)",
    placeholder: "+15555550123",
    initialValue: existingAllowFrom[0],
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const normalized2 = normalizeE164(raw);
      if (!normalized2) {
        return `Invalid number: ${raw}`;
      }
      return void 0;
    }
  });
  const normalized = normalizeE164(String(entry).trim());
  if (!normalized) {
    throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
  }
  const allowFrom = normalizeAllowFromEntries(
    [...existingAllowFrom.filter((item) => item !== "*"), normalized],
    normalizeE164
  );
  return { normalized, allowFrom };
}
async function applyWhatsAppOwnerAllowlist(params) {
  const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
    prompter: params.prompter,
    existingAllowFrom: params.existingAllowFrom
  });
  let next = setWhatsAppSelfChatMode(params.cfg, true);
  next = setWhatsAppDmPolicy(next, "allowlist");
  next = setWhatsAppAllowFrom(next, allowFrom);
  await params.prompter.note(
    [...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"),
    params.title
  );
  return next;
}
function parseWhatsAppAllowFromEntries(raw) {
  const parts = splitOnboardingEntries(raw);
  if (parts.length === 0) {
    return { entries: [] };
  }
  const entries = [];
  for (const part of parts) {
    if (part === "*") {
      entries.push("*");
      continue;
    }
    const normalized = normalizeE164(part);
    if (!normalized) {
      return { entries: [], invalidEntry: part };
    }
    entries.push(normalized);
  }
  return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}
async function promptWhatsAppAllowFrom(cfg, _runtime, prompter, options) {
  const existingPolicy = cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = cfg.channels?.whatsapp?.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
  if (options?.forceAllowlist) {
    return await applyWhatsAppOwnerAllowlist({
      cfg,
      prompter,
      existingAllowFrom,
      title: "WhatsApp allowlist",
      messageLines: ["Allowlist mode enabled."]
    });
  }
  await prompter.note(
    [
      "WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
      "- pairing (default): unknown senders get a pairing code; owner approves",
      "- allowlist: unknown senders are blocked",
      '- open: public inbound DMs (requires allowFrom to include "*")',
      "- disabled: ignore WhatsApp DMs",
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
    ].join("\n"),
    "WhatsApp DM access"
  );
  const phoneMode = await prompter.select({
    message: "WhatsApp phone setup",
    options: [
      { value: "personal", label: "This is my personal phone number" },
      { value: "separate", label: "Separate phone just for OpenClaw" }
    ]
  });
  if (phoneMode === "personal") {
    return await applyWhatsAppOwnerAllowlist({
      cfg,
      prompter,
      existingAllowFrom,
      title: "WhatsApp personal phone",
      messageLines: [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)"
      ]
    });
  }
  const policy = await prompter.select({
    message: "WhatsApp DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist only (block unknown senders)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore WhatsApp DMs)" }
    ]
  });
  let next = setWhatsAppSelfChatMode(cfg, false);
  next = setWhatsAppDmPolicy(next, policy);
  if (policy === "open") {
    const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
    next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
    return next;
  }
  if (policy === "disabled") {
    return next;
  }
  const allowOptions = existingAllowFrom.length > 0 ? [
    { value: "keep", label: "Keep current allowFrom" },
    {
      value: "unset",
      label: "Unset allowFrom (use pairing approvals only)"
    },
    { value: "list", label: "Set allowFrom to specific numbers" }
  ] : [
    { value: "unset", label: "Unset allowFrom (default)" },
    { value: "list", label: "Set allowFrom to specific numbers" }
  ];
  const mode = await prompter.select({
    message: "WhatsApp allowFrom (optional pre-allowlist)",
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label
    }))
  });
  if (mode === "keep") {
  } else if (mode === "unset") {
    next = setWhatsAppAllowFrom(next, void 0);
  } else {
    const allowRaw = await prompter.text({
      message: "Allowed sender numbers (comma-separated, E.164)",
      placeholder: "+15555550123, +447700900123",
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return "Required";
        }
        const parsed2 = parseWhatsAppAllowFromEntries(raw);
        if (parsed2.entries.length === 0 && !parsed2.invalidEntry) {
          return "Required";
        }
        if (parsed2.invalidEntry) {
          return `Invalid number: ${parsed2.invalidEntry}`;
        }
        return void 0;
      }
    });
    const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
    next = setWhatsAppAllowFrom(next, parsed.entries);
  }
  return next;
}
const whatsappOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const defaultAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const accountId = resolveOnboardingAccountId({
      accountId: accountOverrides.whatsapp,
      defaultAccountId
    });
    const linked = await detectWhatsAppLinked(cfg, accountId);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
    return {
      channel,
      configured: linked,
      statusLines: [`WhatsApp (${accountLabel}): ${linked ? "linked" : "not linked"}`],
      selectionHint: linked ? "linked" : "not linked",
      quickstartScore: linked ? 5 : 4
    };
  },
  configure: async ({
    cfg,
    runtime,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom
  }) => {
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "WhatsApp",
      accountOverride: accountOverrides.whatsapp,
      shouldPromptAccountIds: Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
      listAccountIds: listWhatsAppAccountIds,
      defaultAccountId: resolveDefaultWhatsAppAccountId(cfg)
    });
    let next = cfg;
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            accounts: {
              ...next.channels?.whatsapp?.accounts,
              [accountId]: {
                ...next.channels?.whatsapp?.accounts?.[accountId],
                enabled: next.channels?.whatsapp?.accounts?.[accountId]?.enabled ?? true
              }
            }
          }
        }
      };
    }
    const linked = await detectWhatsAppLinked(next, accountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId
    });
    if (!linked) {
      await prompter.note(
        [
          "Scan the QR with WhatsApp on your phone.",
          `Credentials are stored under ${authDir}/ for future runs.`,
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`
        ].join("\n"),
        "WhatsApp linking"
      );
    }
    const wantsLink = await prompter.confirm({
      message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
      initialValue: !linked
    });
    if (wantsLink) {
      try {
        await loginWeb(false, void 0, runtime, accountId);
      } catch (err) {
        runtime.error(`WhatsApp login failed: ${String(err)}`);
        await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
      }
    } else if (!linked) {
      await prompter.note(
        `Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`,
        "WhatsApp"
      );
    }
    next = await promptWhatsAppAllowFrom(next, runtime, prompter, {
      forceAllowlist: forceAllowFrom
    });
    return { cfg: next, accountId };
  },
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  }
};
export {
  whatsappOnboardingAdapter
};
