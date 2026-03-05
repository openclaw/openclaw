import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createHmac } from 'node:crypto';

dotenv.config();

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 18792;

function resolveRelayAuthTokenForPort(port) {
    const gatewayToken = process.env.MCP_WEB_ADAPTER_TOKEN || "default-token";
    return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

const TOKEN = process.env.DERIVED_EXTENSION_TOKEN || resolveRelayAuthTokenForPort(PORT);
const CDP_URL = `ws://127.0.0.1:${PORT}/cdp?token=${TOKEN}`;
const CACHE_FILE = path.join(process.cwd(), '.node_cache.json');

async function runCommand() {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== 'browser') {
        console.error("Usage: node scripts/run-node.js browser [snapshot|click] [ref]");
        process.exit(1);
    }

    const subCommand = args[1];
    const ws = new WebSocket(CDP_URL);

    let msgId = 1;
    const pending = new Map();

    function send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify(payload));
        });
    }

    ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.id && pending.has(res.id)) {
            const { resolve, reject } = pending.get(res.id);
            pending.delete(res.id);
            if (res.error) reject(res.error);
            else resolve(res.result);
        }
    });

    ws.on('open', async () => {
        try {
            const targetsRes = await send('Target.getTargets');
            const targetId = targetsRes.targetInfos[0]?.targetId;
            if (!targetId) throw new Error("No attached tabs found.");

            const attachRes = await send('Target.attachToTarget', { targetId, flatten: true });
            const sessionId = attachRes.sessionId;

            if (subCommand === 'snapshot') {
                await handleSnapshot(send, sessionId);
            } else if (subCommand === 'click') {
                const ref = args[2];
                if (!ref) throw new Error("Missing ref index (e.g. e001)");
                await handleClick(send, sessionId, ref);
            } else {
                throw new Error("Unknown subcommand: " + subCommand);
            }
            process.exit(0);
        } catch (err) {
            console.error("Error:", err.message);
            process.exit(1);
        }
    });
}

async function handleSnapshot(send, sessionId) {
    console.log("Capturing snapshot...");
    const treeRes = await send('Accessibility.getFullAXTree', {}, sessionId);
    const nodes = treeRes.nodes || [];

    const refMap = {};
    let refCounter = 1;

    function formatRef(n) {
        return `[e${String(n).padStart(3, '0')}]`;
    }

    const output = [];
    const nodeMap = new Map(nodes.map(n => [n.nodeId, n]));

    function walk(nodeId, depth = 0) {
        const node = nodeMap.get(nodeId);
        if (!node) return;

        const role = node.role?.value || 'unknown';
        const name = node.name?.value || '';
        const value = node.value?.value || '';
        const indent = '  '.repeat(depth);

        // Filter: only show interesting nodes to keep snapshot concise
        const isInteresting = role !== 'generic' && role !== 'LineBreak' && (name || value || node.childIds?.length > 0);

        if (isInteresting && role !== 'RootWebArea') {
            const ref = formatRef(refCounter++);
            refMap[ref] = node.backendDOMNodeId;
            output.push(`${indent}- ${ref} ${role} "${name}" ${value ? `(value: ${value})` : ''}`);
        }

        if (node.childIds) {
            for (const childId of node.childIds) {
                walk(childId, depth + (isInteresting ? 1 : 0));
            }
        }
    }

    const root = nodes.find(n => n.role?.value === 'RootWebArea');
    if (root) walk(root.nodeId);

    console.log("\n--- BROWSER SNAPSHOT ---\n");
    console.log(output.join('\n'));
    console.log("\n--- END SNAPSHOT ---\n");

    fs.writeFileSync(CACHE_FILE, JSON.stringify(refMap, null, 2));
}

async function handleClick(send, sessionId, ref) {
    if (!fs.existsSync(CACHE_FILE)) {
        throw new Error("No snapshot cache found. Run 'snapshot' first.");
    }
    const refMap = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const backendNodeId = refMap[ref];
    if (!backendNodeId) {
        throw new Error(`Ref ${ref} not found in cache.`);
    }

    console.log(`Clicking ${ref} (backendNodeId: ${backendNodeId})...`);

    // Resolve node to object ID
    const resolved = await send('DOM.resolveNode', { backendNodeId }, sessionId);
    const remoteObjectId = resolved.object.remoteObjectId;

    // Scroll into view
    await send('Runtime.callFunctionOn', {
        functionDeclaration: 'function() { this.scrollIntoViewIfNeeded(); }',
        remoteObjectId
    }, sessionId);

    // Get clickable coordinates
    const box = await send('DOM.getBoxModel', { backendNodeId }, sessionId);
    const [x1, y1, x2, y2, x3, y3, x4, y4] = box.model.content;
    const centerX = (x1 + x2 + x3 + x4) / 4;
    const centerY = (y1 + y2 + y3 + y4) / 4;

    // Dispatch mouse events
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centerX, y: centerY, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centerX, y: centerY, button: 'left', clickCount: 1 }, sessionId);

    console.log("Click successful.");
}

runCommand();
