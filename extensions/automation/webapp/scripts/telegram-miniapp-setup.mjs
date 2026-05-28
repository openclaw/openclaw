#!/usr/bin/env node

/**
 * Telegram Mini App menu button setup helper.
 *
 * 預設為 dry-run，只輸出將要送出的 payload。
 * 使用 --apply 才會實際呼叫 Telegram Bot API。
 */

const DEFAULT_BUTTON_TEXT = "SuperClaw";

function parseArgs(argv) {
  const args = {
    apply: false,
    validateToken: false,
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    webAppUrl: process.env.OPENCLAW_MINIAPP_URL ?? "",
    buttonText: DEFAULT_BUTTON_TEXT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--validate-token") {
      args.validateToken = true;
      continue;
    }
    if (token === "--bot-token") {
      args.botToken = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token === "--webapp-url") {
      args.webAppUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (token === "--button-text") {
      args.buttonText = argv[index + 1] ?? DEFAULT_BUTTON_TEXT;
      index += 1;
    }
  }

  return args;
}

function ensureHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Mini App URL 必須使用 https");
    }
    return parsed.toString();
  } catch (error) {
    throw new Error(
      `無效的 webapp URL: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.validateToken) {
    if (!args.botToken) {
      throw new Error("缺少 bot token（請提供 --bot-token 或設定 TELEGRAM_BOT_TOKEN）");
    }

    const tokenEndpoint = `https://api.telegram.org/bot${args.botToken}/getMe`;
    const tokenResponse = await fetch(tokenEndpoint);
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || tokenResult?.ok !== true || !tokenResult?.result) {
      throw new Error(`Token 驗證失敗: ${JSON.stringify(tokenResult)}`);
    }

    const botProfile = tokenResult.result;
    console.log(
      JSON.stringify(
        {
          mode: "validate-token",
          ok: true,
          bot: {
            id: botProfile.id,
            username: botProfile.username ?? "",
            first_name: botProfile.first_name ?? "",
          },
          next_step:
            "Token 驗證成功。下一步：pnpm --dir extensions/automation/webapp telegram:miniapp:setup -- --apply --bot-token <TOKEN> --webapp-url <HTTPS_URL>",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!args.webAppUrl) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          ok: false,
          error_code: "MISSING_WEBAPP_URL",
          next_step: "請補上 --webapp-url <HTTPS_URL> 或設定 OPENCLAW_MINIAPP_URL 後重試。",
        },
        null,
        2,
      ),
    );
    return;
  }

  const normalizedUrl = ensureHttpsUrl(args.webAppUrl);

  const payload = {
    menu_button: {
      type: "web_app",
      text: args.buttonText,
      web_app: {
        url: normalizedUrl,
      },
    },
  };

  if (!args.apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          ok: true,
          next_step:
            "若要套用，執行：pnpm --dir extensions/automation/webapp telegram:miniapp:setup -- --apply --bot-token <TOKEN> --webapp-url <HTTPS_URL>",
          payload,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!args.botToken) {
    throw new Error("缺少 bot token（請提供 --bot-token 或設定 TELEGRAM_BOT_TOKEN）");
  }

  const endpoint = `https://api.telegram.org/bot${args.botToken}/setChatMenuButton`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error(`Telegram API 失敗: ${JSON.stringify(result)}`);
  }

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        ok: true,
        method: "setChatMenuButton",
        webAppUrl: normalizedUrl,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
