import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.DERIVED_EXTENSION_TOKEN || process.env.MCP_WEB_ADAPTER_TOKEN || "default-token";
const CDP_URL = `ws://127.0.0.1:18792/cdp?token=${TOKEN}`;
const TARGET_URL = 'https://novellive.app/book/harem-system-spending-money-on-women-for-100-rebate/chapter-1-the-beginning';
const MAX_CHAPTERS = 10;

const ws = new WebSocket(CDP_URL);

let msgId = 1;
const pending = new Map();
let currentSessionId = null;

function sendCommand(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
        const id = msgId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
    });
}

ws.on('open', async () => {
    console.log('Connected to CDP Relay. Identifying targets...');
    try {
        const targetsRes = await sendCommand('Target.getTargets');
        const targetInfos = targetsRes.targetInfos || [];
        if (targetInfos.length === 0) {
            console.error("No browser targets attached to the relay extension.");
            process.exit(1);
        }

        const targetId = targetInfos[0].targetId;
        console.log(`Attaching to target ${targetId}`);

        const attachRes = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
        currentSessionId = attachRes.sessionId;

        console.log(`Attached successfully! Session ID: ${currentSessionId}`);
        await scrapeLoop();

    } catch (err) {
        console.error("Failed CDP setup:", err);
        process.exit(1);
    }
});

ws.on('message', (data) => {
    const res = JSON.parse(data.toString());
    if (res.id && pending.has(res.id)) {
        const { resolve, reject } = pending.get(res.id);
        pending.delete(res.id);
        if (res.error) reject(res.error);
        else resolve(res.result);
    }
});

async function evaluateInPage(expression) {
    const res = await sendCommand('Runtime.evaluate', {
        expression: `(${expression})()`,
        returnByValue: true,
        awaitPromise: true
    }, currentSessionId);
    if (res.exceptionDetails) {
        throw new Error("Evaluation error: " + JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
}

async function scrapeLoop() {
    // Reset output
    if (fs.existsSync('novel_content.txt')) fs.unlinkSync('novel_content.txt');

    console.log(`Navigating to ${TARGET_URL}`);
    await evaluateInPage(`() => window.location.href = '${TARGET_URL}'`);
    await new Promise(r => setTimeout(r, 6000)); // wait for page load

    let chaptersProcessed = 0;

    while (chaptersProcessed < MAX_CHAPTERS) {
        console.log(`\n--- Reading Chapter ${chaptersProcessed + 1} ---`);
        await new Promise(r => setTimeout(r, 3000)); // Additional wait for dynamic content

        try {
            const data = await evaluateInPage(`() => {
                const titleEl = document.querySelector('.chapter') || document.querySelector('.tit a') || document.querySelector('h1');
                const title = titleEl ? titleEl.innerText.trim() : document.title;
                
                // Collect paragraphs from within the .txt container
                const textArray = Array.from(document.querySelectorAll('.txt p'))
                    .map(el => el.innerText.trim())
                    .filter(t => t.length > 0);

                // Find the Next Chapter link
                const nextBtn = document.querySelector('#next') || Array.from(document.querySelectorAll('a')).find(b => {
                    const txt = b.innerText.toLowerCase();
                    return txt.includes('next chapter') || txt === 'next';
                });

                return {
                    title,
                    text: textArray.join('\\n\\n'),
                    nextUrl: nextBtn ? nextBtn.href : null
                };
            }`);

            console.log(`Title: ${data.title}`);
            console.log(`Paragraphs: ${data.text.split('\\n\\n').length}`);

            const content = `\n\n=== ${data.title} ===\n\n${data.text}\n\n`;
            fs.appendFileSync('novel_content.txt', content);
            console.log(`Saved to 'novel_content.txt'.`);

            if (!data.nextUrl || data.nextUrl.includes('#')) {
                console.log("No valid next chapter. Stopping.");
                break;
            }

            console.log(`Navigating to next: ${data.nextUrl}`);
            await evaluateInPage(`() => window.location.href = '${data.nextUrl}'`);

            chaptersProcessed++;
        } catch (e) {
            console.error("Error evaluating page:", e);
            break;
        }
    }

    console.log("\nScraping complete.");
    process.exit(0);
}
