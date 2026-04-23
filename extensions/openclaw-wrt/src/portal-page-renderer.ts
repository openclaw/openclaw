export const PORTAL_TEMPLATE_VALUES = [
  "default",
  "welcome",
  "business",
  "cafe",
  "hotel",
  "terms",
  "voucher",
  "event",
] as const;

export type PortalTemplate = (typeof PORTAL_TEMPLATE_VALUES)[number];

export type PortalContent = {
  brandName?: string;
  networkName?: string;
  venueName?: string;
  title?: string;
  body?: string;
  buttonText?: string;
  footerText?: string;
  supportText?: string;
  voucherLabel?: string;
  voucherHint?: string;
  rules?: string[];
  accentColor?: string;
};

const ICONS: Record<string, string> = {
  wifi: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>`,
  business: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`,
  cafe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`,
  hotel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M5 21V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14"></path><path d="M9 21v-4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"></path><path d="M10 9h.01"></path><path d="M14 9h.01"></path><path d="M10 13h.01"></path><path d="M14 13h.01"></path></svg>`,
  terms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  voucher: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line><line x1="7" y1="15" x2="7.01" y2="15"></line><line x1="11" y1="15" x2="13" y2="15"></line></svg>`,
  event: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>`,
  welcome: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readPortalText(input: unknown): string {
  return typeof input === "string" && input.trim() ? input.trim() : "";
}

function pickPortalText(...values: unknown[]): string {
  for (const value of values) {
    const text = readPortalText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function isSafePortalColor(value: string): boolean {
  return (
    /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8})$/.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s/,]+\)$/.test(value) ||
    /^[a-zA-Z][a-zA-Z-]*$/.test(value)
  );
}

function portalColor(template?: PortalTemplate, accentColor?: string): string {
  const candidate = readPortalText(accentColor);
  if (candidate && isSafePortalColor(candidate)) {
    return candidate;
  }
  // template-specific professional defaults
  switch (template) {
    case "business":
      return "#1e40af"; // Deep blue
    case "cafe":
      return "#d97706"; // Warm amber
    case "hotel":
      return "#059669"; // Sophisticated emerald
    case "event":
      return "#7c3aed"; // Vibrant violet
    case "welcome":
      return "#db2777"; // Friendly pink
    default:
      return "#3182ce"; // Standard blue
  }
}

function buildPortalContext(params: {
  deviceId: string;
  template?: PortalTemplate;
  content?: PortalContent;
}) {
  const content = params.content ?? {};
  const networkName = pickPortalText(content.networkName, content.brandName, "访客网络");
  const venueName = pickPortalText(content.venueName, content.brandName, networkName);
  const title = pickPortalText(content.title);
  const body = pickPortalText(content.body, content.supportText);
  const buttonText = pickPortalText(content.buttonText);
  const footerText = pickPortalText(content.footerText);
  const accentColor = portalColor(params.template, content.accentColor);

  return {
    template: params.template ?? "default",
    deviceId: params.deviceId,
    networkName,
    venueName,
    title,
    body,
    buttonText,
    footerText,
    supportText: readPortalText(content.supportText),
    voucherLabel: pickPortalText(content.voucherLabel, "接入券码"),
    voucherHint: pickPortalText(content.voucherHint, "请输入现场提供的券码"),
    rules: Array.isArray(content.rules)
      ? content.rules.map((rule) => rule.trim()).filter(Boolean)
      : [],
    accentColor,
  };
}

export function renderPortalPageHtml(params: {
  deviceId: string;
  template?: PortalTemplate;
  content?: PortalContent;
}): string {
  const ctx = buildPortalContext(params);
  const escapedNetwork = escapeHtml(ctx.networkName);

  const templateIconKey = ctx.template === "default" ? "wifi" : ctx.template;
  const iconSvg = ICONS[templateIconKey] || ICONS.wifi;

  const escapedTitle = escapeHtml(
    ctx.title ||
      (ctx.template === "welcome"
        ? `欢迎来到 ${ctx.venueName}`
        : ctx.template === "business"
          ? "企业访客网络"
          : ctx.template === "cafe"
            ? "轻松浏览"
            : ctx.template === "hotel"
              ? "宾客网络"
              : ctx.template === "terms"
                ? "请先阅读并同意使用条款"
                : ctx.template === "voucher"
                  ? "请输入接入券码"
                  : ctx.template === "event"
                    ? "欢迎参与本次活动"
                    : `欢迎使用 ${ctx.networkName}`),
  );
  const escapedBody = escapeHtml(
    ctx.body ||
      (ctx.template === "welcome"
        ? "页面已打开，继续浏览即可。"
        : ctx.template === "business"
          ? "这是安全尊享的访客网络。"
          : ctx.template === "cafe"
            ? "点杯饮品，畅享在线时光。"
            : ctx.template === "hotel"
              ? "宾客网络已就绪，欢迎使用。"
              : ctx.template === "terms"
                ? "为确保公平使用，请先查看规则。"
                : ctx.template === "voucher"
                  ? "请输入现场提供的专用接入券码。"
                  : ctx.template === "event"
                    ? "活动详情已准备好，点击继续查看。"
                    : `您已成功接入 ${ctx.networkName}。`),
  );
  const buttonText = escapeHtml(
    ctx.buttonText ||
      (ctx.template === "terms"
        ? "同意并继续"
        : ctx.template === "voucher"
          ? "提交并接入"
          : ctx.template === "business"
            ? "开始使用"
            : ctx.template === "hotel"
              ? "即刻接入"
              : ctx.template === "event"
                ? "进入活动"
                : "开始上网"),
  );
  const footerText = escapeHtml(
    ctx.footerText ||
      (ctx.template === "terms"
        ? "继续使用即表示您接受以上条款。"
        : ctx.template === "voucher"
          ? "如券码无效，请咨询现场服务人员。"
          : ctx.template === "business"
            ? "如需技术支持，请联系 IT 部门。"
            : ctx.template === "cafe"
              ? "品味咖啡，畅享网络。"
              : ctx.template === "hotel"
                ? "如有疑问，请咨询前台。"
                : ctx.template === "event"
                  ? "感谢您的参与。"
                  : "由 OpenClaw 提供安全驱动."),
  );
  const supportText = escapeHtml(ctx.supportText);
  const rules =
    ctx.rules.length > 0
      ? ctx.rules
      : ["请遵守当地法律法规 and 网络使用守则。", "请勿分发违法违规内容。"];
  const rulesHtml = rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("");

  const sharedStyles = `
    :root {
      color-scheme: light dark;
      --bg-h: 222;
      --bg-s: 47%;
      --bg-dark: hsl(var(--bg-h), var(--bg-s), 8%);
      --bg-light: hsl(var(--bg-h), var(--bg-s), 97%);
      --accent: ${ctx.accentColor};
      --accent-glow: color-mix(in srgb, var(--accent) 50%, transparent);
      --accent-soft: color-mix(in srgb, var(--accent) 12%, transparent);
      --glass-bg: rgba(255, 255, 255, 0.7);
      --glass-border: rgba(255, 255, 255, 0.4);
      --text-main: hsl(var(--bg-h), 40%, 15%);
      --text-muted: hsl(var(--bg-h), 15%, 45%);
      --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
      --shadow-xl: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --glass-bg: rgba(15, 23, 42, 0.65);
        --glass-border: rgba(255, 255, 255, 0.08);
        --text-main: hsl(var(--bg-h), 30%, 95%);
        --text-muted: hsl(var(--bg-h), 20%, 70%);
      }
    }

    * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
    
    html, body { 
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-light);
    }

    @media (prefers-color-scheme: dark) {
      body { background: var(--bg-dark); }
    }

    .bg-blobs {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: -1;
      overflow: hidden;
      background: var(--bg-light);
      transition: background 0.5s ease;
    }

    @media (prefers-color-scheme: dark) {
      .bg-blobs { background: var(--bg-dark); }
    }

    .blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(100px);
      opacity: 0.5;
      animation: drift 25s infinite alternate ease-in-out;
      pointer-events: none;
    }

    .blob-1 {
      width: 600px;
      height: 600px;
      background: var(--accent);
      top: -200px;
      right: -150px;
      opacity: 0.3;
    }

    .blob-2 {
      width: 500px;
      height: 500px;
      background: #7c3aed;
      bottom: -150px;
      left: -100px;
      animation-delay: -7s;
      opacity: 0.25;
    }

    .blob-3 {
      width: 400px;
      height: 400px;
      background: #3b82f6;
      top: 40%;
      left: 50%;
      transform: translate(-50%, -50%);
      animation: drift 30s infinite reverse ease-in-out;
      opacity: 0.2;
    }

    @keyframes drift {
      0% { transform: translate(0, 0) scale(1) rotate(0deg); }
      50% { transform: translate(40px, 60px) scale(1.1) rotate(5deg); }
      100% { transform: translate(-20px, 30px) scale(0.9) rotate(-5deg); }
    }

    .container {
      width: 100%;
      max-width: 440px;
      padding: 20px;
      z-index: 1;
    }

    .card {
      background: var(--glass-bg);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid var(--glass-border);
      border-radius: 36px;
      padding: 48px 32px;
      box-shadow: var(--shadow-xl);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      animation: slideUp 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .icon-outer {
      padding: 6px;
      border: 1px solid var(--glass-border);
      border-radius: 50%;
      margin-bottom: 24px;
    }

    .icon-wrapper {
      width: 80px;
      height: 80px;
      background: var(--accent);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      box-shadow: 0 12px 24px -6px var(--accent-glow);
    }

    .icon-wrapper svg { width: 32px; height: 32px; stroke-width: 2.5px; }

    .eyebrow {
      font-size: 14px;
      font-weight: 600;
      color: var(--accent);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 12px;
    }

    h1 {
      font-size: 28px;
      font-weight: 800;
      margin: 0 0 16px;
      line-height: 1.2;
    }

    .description {
      font-size: 16px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 32px;
    }

    .meta-panel {
      width: 100%;
      background: var(--glass-border);
      border-radius: 20px;
      padding: 24px;
      margin-bottom: 32px;
      text-align: left;
      border: 1px solid var(--glass-border);
    }

    .meta-title {
      font-size: 11px;
      font-weight: 800;
      color: var(--accent);
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .rules {
      margin: 0;
      padding-left: 20px;
      font-size: 14px;
      color: var(--text-main);
    }

    .rules li { margin-bottom: 6px; }

    .voucher-input {
      width: 100%;
      height: 56px;
      background: var(--glass-bg);
      border: 1px solid var(--glass-border);
      border-radius: 16px;
      padding: 0 20px;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-main);
      margin-top: 10px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.05);
    }

    .voucher-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 4px var(--accent-glow);
      background: var(--bg-light);
    }

    @media (prefers-color-scheme: dark) {
      .voucher-input:focus { background: var(--bg-dark); }
    }

    .actions {
      width: 100%;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 60px;
      background: var(--accent);
      color: white;
      border-radius: 20px;
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
      box-shadow: 0 10px 20px -5px var(--accent-glow);
      border: none;
      cursor: pointer;
    }

    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 30px -10px var(--accent-glow);
      filter: brightness(1.05);
    }

    .btn:active {
      transform: translateY(1px);
      filter: brightness(0.95);
    }

    .agreement {
      margin-top: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-size: 14px;
      color: var(--text-muted);
      cursor: pointer;
    }

    .agreement input {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
      cursor: pointer;
    }

    .agreement a {
      color: var(--text-main);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .footer {
      margin-top: 24px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .footer-links {
      margin-top: 8px;
      display: flex;
      justify-content: center;
      gap: 16px;
    }

    .footer-links a {
      color: var(--text-muted);
      text-decoration: none;
    }

    .footer-links a:hover { color: var(--accent); }

    @media (max-width: 400px) {
      .card { padding: 32px 24px; }
      h1 { font-size: 24px; }
    }
  `;

  const metaHtml =
    ctx.template === "terms"
      ? `<div class="meta-panel"><div class="meta-title">使用条款</div><ul class="rules">${rulesHtml}</ul></div>`
      : ctx.template === "voucher"
        ? `<div class="meta-panel"><div class="meta-title">${escapeHtml(ctx.voucherLabel)}</div><input class="voucher-input" type="text" placeholder="${escapeHtml(ctx.voucherHint)}" /></div>`
        : supportText
          ? `<div class="meta-panel"><div class="meta-title">温馨提示</div><div style="font-size: 14px;">${supportText}</div></div>`
          : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="${ctx.accentColor}" />
    <title>${escapedTitle}</title>
    <style>${sharedStyles}</style>
  </head>
  <body>
    <div class="bg-blobs">
      <div class="blob blob-1"></div>
      <div class="blob blob-2"></div>
      <div class="blob blob-3"></div>
    </div>
    <main class="container">
      <section class="card" role="main">
        <div class="icon-outer">
          <div class="icon-wrapper">${iconSvg}</div>
        </div>
        <div class="eyebrow">${escapedNetwork}</div>
        <h1>${escapedTitle}</h1>
        <p class="description">${escapedBody}</p>
        
        ${metaHtml}
        
        <div class="actions">
          <a class="btn" href="#continue">${buttonText}</a>
          <label class="agreement">
            <input type="checkbox" checked />
            <span>我已阅读并同意 <a href="#terms">服务条款</a> 和 <a href="#privacy">隐私政策</a></span>
          </label>
        </div>
        
        <div class="footer">
          <div>${footerText}</div>
        </div>
      </section>
    </main>
  </body>
</html>`;
}
