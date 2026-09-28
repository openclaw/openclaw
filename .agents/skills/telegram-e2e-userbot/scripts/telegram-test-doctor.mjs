#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWithLease, runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { selectChatTarget } from "./scenario.mjs";
import { currentTelegramRun, withTelegramRun, runTelegramCli } from "./telegram-run-scope.mjs";
import { telegramPythonArgs } from "./telegram-runtime.mjs";
import { startTelegramTestApiProxy } from "./telegram-test-api-proxy.mjs";
import { acquireTelegramTestCredential } from "./telegram-test-credential.mjs";
import { prepareTelegramTestGroup } from "./telegram-test-group.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_DRIVER_PATH = path.join(SKILL_DIR, "scripts", "user-driver.py");
const MISSING_GROUP_DIAGNOSTIC = "[credential_state_missing_group]";

function readinessFailure(message, diagnostic) {
  return Object.assign(new Error(`${message} Diagnostics: ${JSON.stringify(diagnostic)}`), {
    diagnostic,
  });
}

export async function runTelegramTestDoctor({
  acquireCredential = acquireTelegramTestCredential,
  dm = true,
  ...options
} = {}) {
  return await withTelegramRun(
    async (scope) => {
      scope.assertActive();
      const credential = await scope.acquire(acquireCredential({ signal: scope.signal }));
      scope.observeLease(credential);
      return await checkTelegramTestCredential({ ...options, dm, credential });
    },
    { signal: options.signal },
  );
}

export async function checkTelegramTestCredential({
  credential,
  dm = false,
  chat = "",
  requireForum = false,
  fetchImpl = fetch,
  runCommandImpl = runCommand,
  startProxy = startTelegramTestApiProxy,
}) {
  const scope = currentTelegramRun();
  const leaseHealth = scope.health;
  const lease = leaseHealth;
  let proxy;
  try {
    if (dm && requireForum) throw new Error("Forum-topic proof requires a forum group target.");
    lease.assertHealthy();
    const driverEnv = { ...sanitizeChildEnvironment(), ...credential.driverEnv };
    const requiredChat = dm || chat ? "" : credential.groupId;
    const statusArgs = telegramPythonArgs(
      driverEnv,
      USER_DRIVER_PATH,
      "status",
      "--json",
      "--timeout-ms",
      "25000",
    );
    if (requiredChat) statusArgs.push("--require-chat", requiredChat);
    const started = performance.now();
    const diagnostic = {
      phase: "tdlib-status",
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      signals: [],
    };
    credential.readinessDiagnostic = diagnostic;
    let status;
    try {
      status = await runCommandImpl("uv", statusArgs, {
        cwd: process.cwd(),
        env: driverEnv,
        timeoutMs: 30_000,
      });
    } catch {
      diagnostic.signals.push(scope.signal.aborted ? "cancelled" : "launcher-error");
      throw readinessFailure("TDLib readiness did not complete.", diagnostic);
    } finally {
      diagnostic.durationMs = Math.round(performance.now() - started);
    }
    diagnostic.exitCode = Number.isInteger(status.status) ? status.status : null;
    diagnostic.timedOut = status.timedOut === true;
    diagnostic.stdoutBytes = Buffer.byteLength(status.stdout || "");
    diagnostic.stderrBytes = Buffer.byteLength(status.stderr || "");
    // Only fixed categories cross the private process boundary. Raw output can
    // contain credentials, identities, paths, or unfamiliar sensitive values.
    for (const [name, pattern] of [
      ["permission-denied", /Operation not permitted|Permission denied|EACCES|EPERM/iu],
      ["path-resolution", /realpath/iu],
      ["launcher-missing", /spawn uv ENOENT/iu],
      ["configured-group-missing", /\[credential_state_missing_group\]/u],
    ]) {
      if (pattern.test(status.stderr || "")) {
        diagnostic.signals.push(name);
      }
    }
    lease.assertHealthy();
    if (
      status.status !== 0 &&
      !status.timedOut &&
      status.stderr?.includes(MISSING_GROUP_DIAGNOSTIC)
    ) {
      throw readinessFailure(
        "TDLib Test Server configured group is missing from cold-restored state. Disable and republish this credential.",
        diagnostic,
      );
    }
    if (status.status !== 0 || status.timedOut) {
      throw readinessFailure(
        "TDLib readiness failed. Check the existing uv launcher and TDLib runtime before requesting session repair.",
        diagnostic,
      );
    }
    let driver;
    try {
      driver = JSON.parse(status.stdout);
    } catch {
      diagnostic.signals.push("invalid-json");
      throw readinessFailure("TDLib readiness returned invalid JSON.", diagnostic);
    }
    if (
      driver.ok !== true ||
      driver.authorized !== true ||
      driver.testDc !== true ||
      driver.tdlibVersion !== credential.tdlibVersion ||
      String(driver.user?.id) !== credential.testerUserId
    ) {
      throw new Error("TDLib Test Server user identity does not match the lease.");
    }
    if (requiredChat && String(driver.chatId) !== requiredChat) {
      throw new Error("TDLib Test Server group identity does not match the lease.");
    }
    proxy = scope.ownProxy(await startProxy({ leaseHealth }));
    lease.assertHealthy();
    const requestBot = (method, body) =>
      fetchWithLease(
        `${proxy.apiRoot}/bot${credential.sutToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        lease,
        fetchImpl,
        (response) => response.json(),
      );
    const { response: botResponse, payload: bot } = await requestBot("getMe", {});
    lease.assertHealthy();
    if (!botResponse.ok || bot.ok !== true) {
      throw new Error("Telegram Test Server Bot API proxy request failed.");
    }
    if (
      String(bot.result?.id) !== credential.sutBotId ||
      bot.result?.username !== credential.sutUsername
    ) {
      throw new Error("Telegram Test Server bot identity does not match the lease.");
    }
    const result = {
      ok: true,
      credentialSource: "convex",
      credentialLoaded: true,
      isolatedTdlibState: true,
      testDc: true,
      tdlibAuthorized: true,
      botApiProxy: true,
      sutBot: true,
    };
    if (dm) {
      credential.chatTarget = selectChatTarget({
        dm: true,
        sutUsername: credential.sutUsername,
        testerId: credential.testerUserId,
      });
      return { ...result, chatTarget: { kind: "dm", botId: credential.sutBotId } };
    }
    let selectedChat = chat || credential.groupId;
    if (chat) {
      const resolved = await runCommandImpl(
        "uv",
        telegramPythonArgs(driverEnv, USER_DRIVER_PATH, "resolve-chat", "--chat", chat, "--json"),
        {
          cwd: process.cwd(),
          env: driverEnv,
          timeoutMs: 60_000,
        },
      );
      lease.assertHealthy();
      if (resolved.status !== 0 || resolved.timedOut)
        throw new Error("The leased user could not resolve the selected Telegram chat.");
      const selected = JSON.parse(resolved.stdout);
      if (selected.ok !== true) throw new Error("The selected Telegram chat was not resolved.");
      selectedChat = selected.chatId;
      if (requireForum && selected.isForum !== true)
        throw new Error("The selected Telegram chat is not a forum.");
      if (selected.type["@type"] === "chatTypePrivate") {
        if (String(selected.type.user_id) !== credential.sutBotId)
          throw new Error("The selected private Telegram chat is not the leased SUT.");
        credential.chatTarget = {
          kind: "dm",
          recorderSelector: selectedChat,
          cronDeliveryTarget: credential.testerUserId,
        };
        return { ...result, chatTarget: { kind: "dm", botId: credential.sutBotId } };
      }
    }
    if (bot.result?.can_read_all_group_messages !== true) {
      throw new Error("Telegram Test Server bot group privacy is enabled.");
    }
    let { response: chatResponse, payload: selected } = await requestBot("getChat", {
      chat_id: selectedChat,
    });
    lease.assertHealthy();
    if (!chatResponse.ok || selected.ok !== true) {
      if (chat && [400, 403].includes(selected.error_code)) {
        await prepareTelegramTestGroup(credential, { runCommandImpl, chatId: selectedChat });
        ({ response: chatResponse, payload: selected } = await requestBot("getChat", {
          chat_id: selectedChat,
        }));
        if (!chatResponse.ok || selected.ok !== true)
          throw new Error(
            "The selected Telegram group remains unavailable after membership repair.",
          );
      } else if (chat || selected.error_code !== 400) {
        throw new Error(
          "The selected Telegram group is unavailable; preserve its requested target and repair access.",
        );
      } else {
        if (requireForum)
          throw new Error("Select a prepared forum target before forum-topic proof.");
        await prepareTelegramTestGroup(credential, { runCommandImpl });
      }
    }
    if (selected.ok === true) {
      if (requireForum && selected.result.is_forum !== true)
        throw new Error("The selected Telegram chat is not a forum.");
      if (!["group", "supergroup"].includes(selected.result.type)) {
        throw new Error(
          "The selected Telegram chat is not a group; use --dm for the SUT direct chat.",
        );
      }
      credential.groupId = String(selected.result.id);
      credential.driverEnv.TELEGRAM_USER_DRIVER_CHAT_ID = credential.groupId;
    }
    lease.assertHealthy();
    credential.chatTarget = selectChatTarget({ dm: false, leasedGroupId: credential.groupId });
    const memberRequest = { chat_id: credential.groupId, user_id: credential.sutBotId };
    let { response: membershipResponse, payload: membership } = await requestBot(
      "getChatMember",
      memberRequest,
    );
    if (
      !credential.testGroup &&
      (membership.result?.status === "left" ||
        (!membership.ok && [400, 403].includes(membership.error_code)))
    ) {
      await prepareTelegramTestGroup(credential, { runCommandImpl, chatId: credential.groupId });
      ({ response: membershipResponse, payload: membership } = await requestBot(
        "getChatMember",
        memberRequest,
      ));
    }
    lease.assertHealthy();
    if (
      !membershipResponse.ok ||
      membership.ok !== true ||
      !["administrator", "creator", "member"].includes(membership.result?.status)
    ) {
      throw new Error("Telegram Test Server bot is not an active member of the test group.");
    }
    const testerAccess = await runCommandImpl(
      "uv",
      telegramPythonArgs(
        driverEnv,
        USER_DRIVER_PATH,
        "status",
        "--check-chat",
        credential.groupId,
        "--json",
      ),
      { cwd: process.cwd(), env: driverEnv, timeoutMs: 30_000 },
    );
    lease.assertHealthy();
    if (
      testerAccess.status !== 0 ||
      testerAccess.timedOut ||
      JSON.parse(testerAccess.stdout).testerGroupWriteAccess !== true
    ) {
      throw new Error(
        "The leased tester's selected group membership and text permission were not verified.",
      );
    }
    return {
      ...result,
      chatTarget: {
        kind: "group",
        chatId: credential.groupId,
        type: selected.result?.type ?? "group",
        isForum: selected.result?.is_forum === true,
      },
      groupPrivacyDisabled: true,
      groupMembership: true,
      testerGroupWriteAccess: true,
      testGroup: credential.testGroup,
    };
  } finally {
    await scope.closeProxy(proxy);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, chat, ...extra] = process.argv.slice(2);
  if (
    (mode && mode !== "--dm" && mode !== "--chat") ||
    extra.length ||
    (mode === "--chat" ? !chat : chat)
  ) {
    throw new Error("Usage: telegram-test-doctor.mjs [--dm | --chat <selected-group>]");
  }
  runTelegramCli((signal) => runTelegramTestDoctor({ signal, dm: mode !== "--chat", chat }))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode ||= 1;
    });
}
