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
    expect(await check(source, { state: '{"v":1200}' })).toMatchObject({ errors: [] });
  });

  it("reports an element id used as a global variable", async () => {
    const source = `<button id=s></button><script>s.onclick=function(){};</script>`;
    expect((await check(source)).errors).toEqual([
      "ReferenceError: s is not defined (script 1, line 1) while loading",
    ]);
  });

  it("warns about more than 16 translucent elements, which Telegram may stop", async () => {
    const cells = Array.from({ length: 17 }, () => `<div style="opacity:.8">1</div>`).join("");
    expect((await check(cells)).warnings[0]).toMatch(/^17 elements use opacity below 1/);
    const solid = Array.from({ length: 17 }, () => `<div class=c>1</div>`).join("");
    expect(
      await check(`<style>.c{background:var(--tg-theme-button-color)}</style>${solid}`),
    ).toMatchObject({
      errors: [],
    });
  });

  it("reports a state update whose shape the widget code cannot read", async () => {
    const source = `<p id=o></p><script>
function draw(){var d=JSON.parse(TelegramWidget.chatData);document.getElementById('o').textContent='Voice '+d.v;}
TelegramWidget.onEvent('chatDataChanged',draw);draw();</script>`;
    const state = '{"w":0,"v":0}';
    expect((await check(source, { state, nextState: '{"vote":"v"}' })).warnings[0]).toMatch(
      /shows "undefined" after the state update/,
    );
    expect(await check(source, { state, nextState: '{"w":0,"v":1}' })).toMatchObject({
      errors: [],
    });
  });

  it("accepts undefined or NaN the author wrote as content", async () => {
    expect(await check("<p>JavaScript values: undefined and NaN</p>")).toMatchObject({
      errors: [],
    });
    expect(
      await check(
        `<p id=o></p><script>document.getElementById('o').textContent='Is NaN a number?';</script>`,
      ),
    ).toMatchObject({ errors: [] });
  });

  it("matches Telegram's runtime for theme, viewer, GIFs and the cascade", async () => {
    const theme = `<p id=o></p><script>document.getElementById('o').textContent=TelegramWidget.themeParams.text_color.toUpperCase()+TelegramWidget.viewer.first_name;</script>`;
    expect(await check(theme)).toMatchObject({ errors: [] });
    expect(await check(`<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`)).toMatchObject({
      errors: [],
    });
    const spans = Array.from({ length: 17 }, () => `<span class=cell>1</span>`).join("");
    // A wide-screen media rule never applies in the bubble.
    const media = `<style>@media(min-width:700px){span{opacity:.5}}</style>${spans}`;
    expect(await check(media)).toEqual({ errors: [], warnings: [] });
    // A more specific opaque rule overrides the translucent one, as in CSS.
    expect(await check(`<style>.cell{opacity:1} span{opacity:.5}</style>${spans}`)).toMatchObject({
      errors: [],
    });
    const isRule = `<style>span{opacity:.5}:is(.cell){opacity:1}</style>${spans}`;
    expect(await check(isRule)).toMatchObject({ errors: [] });
    expect((await check(`<style>span{opacity:.5}</style>${spans}`)).warnings[0]).toMatch(
      /^17 elements/,
    );
  });

  it("supports TextEncoder and does not judge widgets using unmodeled web APIs", async () => {
    const encode = `<p id=o></p><script>document.getElementById('o').textContent=new TextEncoder().encode('vote').length;</script>`;
    expect(await check(encode)).toMatchObject({ errors: [] });
    const url = `<script>new URL('https://t.me/x').hostname.length;</script>`;
    expect(await check(url)).toMatchObject({ errors: [], unavailable: "uses URL" });
  });

  it("does not tap disabled buttons", async () => {
    const source = `<button disabled onclick="JSON.parse(TelegramWidget.chatData).choice.id">Confirm</button>`;
    expect(await check(source, { state: '{"choice":null}' })).toMatchObject({ errors: [] });
  });

  it("resolves request() with Telegram's acknowledgment object", async () => {
    const source = `<p id=o></p><button onclick="TelegramWidget.request('vote').then(function(a){document.getElementById('o').textContent=String(a.result===null)})">Vote</button>`;
    expect(await check(source)).toMatchObject({ errors: [] });
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
