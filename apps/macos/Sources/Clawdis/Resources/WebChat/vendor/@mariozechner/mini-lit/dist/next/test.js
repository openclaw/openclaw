// @ts-expect-error
import { parse } from "html-parse-string/dist/index.js";
import { signal } from "./signals";
const HOLE_MARKER = "$__HOLE__$";
function html(strings, ..._values) {
    let html = "";
    for (const s of strings) {
        html += s + "$__HOLE__$";
    }
    html = html.slice(0, -HOLE_MARKER.length);
    const ast = parse(html);
    return { html, ast };
}
const someValue = signal(42);
const result = html `
<div attr="Some ${someValue}" .prop=${() => console.log("prop")}>
    ${"Hello, world!"}
</div>`;
console.log(JSON.stringify(result, null, 2)); // <div>Hello, world!</div>
//# sourceMappingURL=test.js.map