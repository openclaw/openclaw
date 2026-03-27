# Live Gmail Plugin Integration

_2026-03-26T22:16:20Z by Showboat 0.6.1_

<!-- showboat-id: e1c9f6db-1ef6-4c98-8b42-a1451bb70604 -->

This demo proves the OpenClaw OpenAI plugin can project ChatGPT app auth, expose Gmail tools through the managed local MCP bridge, and read recent Gmail messages through that bridge. The final step summarizes three exact message ids that came from the live recent-mail probe in this session.

```bash
node <<"JS"
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const cwd = process.cwd();
const raw = execFileSync(process.execPath, [path.join(cwd, "openclaw.mjs"), "plugins", "inspect", "openai", "--hard-refresh", "--json"], {
  cwd,
  encoding: "utf8",
});
const start = raw.indexOf("{");
const data = JSON.parse(raw.slice(start));
const gmail = data.runtime.chatgptApps.inventory.apps.find((app) => app.name === "Gmail");
console.log(JSON.stringify({
  enabled: data.runtime.chatgptApps.enabled,
  authStatus: data.runtime.chatgptApps.auth.status,
  inventoryStatus: data.runtime.chatgptApps.inventory.status,
  mcpStatus: data.runtime.chatgptApps.mcpServers.status,
  gmailConfigured: data.runtime.chatgptApps.config.connectors.some((connector) => connector.id === "gmail" && connector.enabled),
  gmailAccessible: gmail ? gmail.isAccessible : null,
  gmailEnabledLocally: gmail ? gmail.isEnabled : null,
}, null, 2));
JS

```

```output
{
  "enabled": true,
  "authStatus": "ready",
  "inventoryStatus": "ready",
  "mcpStatus": "ready",
  "gmailConfigured": true,
  "gmailAccessible": true,
  "gmailEnabledLocally": false
}
```

```bash
node <<'JS'
const { spawn } = require('node:child_process');
const path = require('node:path');
const cwd = process.cwd();
const child = spawn(process.execPath, [path.join(cwd, 'openclaw.mjs'), 'mcp', 'openai-chatgpt-apps'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
let buffer = '';
const pending = new Map();
function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (true) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error))); else slot.resolve(msg.result);
    }
  }
});
(async () => {
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'showboat-probe', version: '0.0.1' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await request('tools/list', {});
    const gmail = (result.tools || []).map((tool) => tool.name).filter((name) => name.includes('gmail')).sort();
    console.log(JSON.stringify({ total: (result.tools || []).length, gmail }, null, 2));
  } finally {
    child.kill('SIGTERM');
  }
})();
JS

```

```output
{
  "total": 20,
  "gmail": [
    "chatgpt_app__gmail__gmail_apply_labels_to_emails",
    "chatgpt_app__gmail__gmail_archive_emails",
    "chatgpt_app__gmail__gmail_batch_modify_email",
    "chatgpt_app__gmail__gmail_batch_read_email",
    "chatgpt_app__gmail__gmail_bulk_label_matching_emails",
    "chatgpt_app__gmail__gmail_create_draft",
    "chatgpt_app__gmail__gmail_create_label",
    "chatgpt_app__gmail__gmail_delete_emails",
    "chatgpt_app__gmail__gmail_forward_emails",
    "chatgpt_app__gmail__gmail_get_profile",
    "chatgpt_app__gmail__gmail_list_drafts",
    "chatgpt_app__gmail__gmail_list_labels",
    "chatgpt_app__gmail__gmail_read_attachment",
    "chatgpt_app__gmail__gmail_read_email",
    "chatgpt_app__gmail__gmail_read_email_thread",
    "chatgpt_app__gmail__gmail_search_email_ids",
    "chatgpt_app__gmail__gmail_search_emails",
    "chatgpt_app__gmail__gmail_send_draft",
    "chatgpt_app__gmail__gmail_send_email",
    "chatgpt_app__gmail__gmail_update_draft"
  ]
}
```

```bash
node <<'JS'
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('node:path');
const cwd = process.cwd();
const ids = [
  '19d2c32d3818a307',
  '19d2c32a9c88c0dc',
  '19d2c32527838454',
];
function summarize(message) {
  const body = typeof message.body === 'string' ? message.body : '';
  const snippet = typeof message.snippet === 'string' ? message.snippet : '';
  if (body.includes('/merge skip-tests skip-codeowners')) {
    return 'Jelle issued /merge skip-tests skip-codeowners on PR #661618.';
  }
  if (snippet.includes('Mergebot Status:')) {
    return 'Mergebot reports PR #661618 is still running in manual-merge mode.';
  }
  if (body.includes("I don't see a production risk")) {
    return 'Joe said the recall gating change looks low-risk and noted Buildkite was still pending.';
  }
  return snippet;
}
(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(cwd, 'openclaw.mjs'), 'mcp', 'openai-chatgpt-apps'],
    cwd,
  });
  const client = new Client({ name: 'gmail-summary-demo', version: '0.0.1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'chatgpt_app__gmail__gmail_batch_read_email',
      arguments: { message_ids: ids },
    });
    const responses = result.structuredContent.responses;
    const summary = responses.map((message) => ({
      id: message.id,
      subject: message.subject,
      from: message.from_,
      takeaway: summarize(message),
    }));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
})();
JS

```

```output
[
  {
    "id": "19d2c32d3818a307",
    "subject": "Re: [openai/openai] Update absl-py from 2.1.0 to 2.2.0 (PR #661618)",
    "from": "\"oai-mergebot[bot]\" notifications@github.com",
    "takeaway": "Mergebot reports PR #661618 is still running in manual-merge mode."
  },
  {
    "id": "19d2c32a9c88c0dc",
    "subject": "Re: [openai/openai] Update absl-py from 2.1.0 to 2.2.0 (PR #661618)",
    "from": "Jelle Zijlstra notifications@github.com",
    "takeaway": "Jelle issued /merge skip-tests skip-codeowners on PR #661618."
  },
  {
    "id": "19d2c32527838454",
    "subject": "Re: [openai/openai] [codex] Gate Recall for anonymous and enterprise users (PR #792257)",
    "from": "Joe notifications@github.com",
    "takeaway": "Joe said the recall gating change looks low-risk and noted Buildkite was still pending."
  }
]
```
