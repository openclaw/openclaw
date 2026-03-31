export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "unknown";
  const connectedAccountId = searchParams.get("connected_account_id") ?? "";

  const success = status === "success";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${success ? "Connected" : "Connection Failed"} — DenchClaw</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #09090b; color: #fafafa;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 2rem;
    }
    .card {
      max-width: 420px; width: 100%; text-align: center;
      padding: 3rem 2rem; border-radius: 1rem;
      border: 1px solid #27272a; background: #18181b;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #a1a1aa; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${success ? "Connected successfully" : "Connection failed"}</h1>
    <p>${success ? "You can close this tab and return to DenchClaw." : "Something went wrong. Please close this tab and try again."}</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({
          type: "composio-callback",
          status: "${status}",
          connected_account_id: "${connectedAccountId}"
        }, "*");
      }
    } catch (_) {}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
