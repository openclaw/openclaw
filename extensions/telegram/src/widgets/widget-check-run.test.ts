import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { runTelegramWidgetCheck } from "./widget-check-run.js";

let wasm: WebAssembly.Module;
beforeAll(async () => {
  wasm = await WebAssembly.compile(
    await readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")),
  );
});
const check = (source: string, extra: { state?: string | null; nextState?: string | null } = {}) =>
  runTelegramWidgetCheck(
    { source, state: extra.state ?? null, tapAll: extra.nextState === undefined, ...extra },
    wasm,
  );

// Each case reproduces a widget a real model sent that Telegram showed broken (live E2E, 2026-11-10).
describe("Telegram widget trial run", () => {
  it("passes a working widget with taps, timers, Intl and state", async () => {
    const source = `<div id=n></div><div class=row><button id=b onclick="vote()">Vote</button></div>
<script>
var s=JSON.parse(TelegramWidget.chatData||'{"v":0}');
function draw(){document.getElementById('n').textContent=s.v.toLocaleString('en-IN')+' votes';}
function vote(){TelegramWidget.request('vote');document.getElementById('b').disabled=true;}
TelegramWidget.onEvent('chatDataChanged',function(){s=JSON.parse(TelegramWidget.chatData);draw();});
setInterval(draw,500);draw();
</script>`;
    expect(await check(source, { state: '{"v":1200}' })).toEqual({ errors: [] });
  });

  it("reports an element id used as a global variable", async () => {
    const source = `<button id=s></button><script>s.onclick=function(){};</script>`;
    expect((await check(source)).errors).toEqual([
      "ReferenceError: s is not defined (script 1, line 1) while loading",
    ]);
  });

  it("reports more than 16 translucent elements, which Telegram stops", async () => {
    const cells = Array.from({ length: 17 }, () => `<div style="opacity:.8">1</div>`).join("");
    expect((await check(cells)).errors[0]).toMatch(/^17 elements use opacity below 1/);
    const solid = Array.from({ length: 17 }, () => `<div class=c>1</div>`).join("");
    expect(
      await check(`<style>.c{background:var(--tg-theme-button-color)}</style>${solid}`),
    ).toEqual({
      errors: [],
    });
  });

  it("reports a state update whose shape the widget code cannot read", async () => {
    const source = `<p id=o></p><script>
function draw(){var d=JSON.parse(TelegramWidget.chatData);document.getElementById('o').textContent='Voice '+d.v;}
TelegramWidget.onEvent('chatDataChanged',draw);draw();</script>`;
    const state = '{"w":0,"v":0}';
    expect((await check(source, { state, nextState: '{"vote":"v"}' })).errors[0]).toMatch(
      /shows "undefined" after the state update/,
    );
    expect(await check(source, { state, nextState: '{"w":0,"v":1}' })).toEqual({ errors: [] });
  });

  it("reports errors that only happen after a tap", async () => {
    const source = `<button onclick="TelegramWidget.request('x'.repeat(80))">Go</button>`;
    expect((await check(source)).errors[0]).toMatch(/must be a string of 1 to 64 bytes/);
  });

  it("reports requests outside a tap and removed or network-bound content", async () => {
    const { errors } = await check(
      `<style>.a{height:50vh}.l{overflow-y:auto}</style><input><img src="https://x/y.png"><script>TelegramWidget.request('boot');</script>`,
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/request\(\) ran while loading, outside a tap/),
        expect.stringMatching(/^<input>/),
        expect.stringMatching(/^<img src=/),
        expect.stringMatching(/vh units/),
        expect.stringMatching(/widgets cannot scroll/),
      ]),
    );
  });

  it("stops an endless loop within the time limit", async () => {
    const started = performance.now();
    const { errors } = await check("<script>for(;;){}</script>");
    expect(errors).toEqual([expect.stringMatching(/did not finish running within a second/)]);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
