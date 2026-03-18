import { t as javascript_default } from "./javascript-Cfn7mP_w.js";
import { t as css_default } from "./css-Dvi0Ud0q.js";
import { t as html_default } from "./html-CACJylAD.js";
import { t as xml_default } from "./xml-4148ngfF.js";
import { t as typescript_default } from "./typescript-B9JlZPhb.js";
import { t as sql_default } from "./sql-BcrAFFT_.js";
import { t as glsl_default } from "./glsl-CvSt79W4.js";
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/es-tag-css.mjs
const lang$5 = Object.freeze(JSON.parse("{\"fileTypes\":[\"js\",\"jsx\",\"ts\",\"tsx\",\"html\",\"vue\",\"svelte\",\"php\",\"res\"],\"injectTo\":[\"source.ts\",\"source.js\"],\"injectionSelector\":\"L:source.js -comment -string, L:source.js -comment -string, L:source.jsx -comment -string,  L:source.js.jsx -comment -string, L:source.ts -comment -string, L:source.tsx -comment -string, L:source.rescript -comment -string, L:source.vue -comment -string, L:source.svelte -comment -string, L:source.php -comment -string, L:source.rescript -comment -string\",\"injections\":{\"L:source\":{\"patterns\":[{\"match\":\"<\",\"name\":\"invalid.illegal.bad-angle-bracket.html\"}]}},\"name\":\"es-tag-css\",\"patterns\":[{\"begin\":\"(?i)(\\\\s?/\\\\*\\\\s?((?:|inline-)css)\\\\s?\\\\*/\\\\s?)(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.css\"},{\"include\":\"inline.es6-htmlx#template\"}]},{\"begin\":\"(?i)(\\\\s*((?:|inline-)css))(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.css\"},{\"include\":\"inline.es6-htmlx#template\"},{\"include\":\"string.quoted.other.template.js\"}]},{\"begin\":\"(?i)(?<=[(,:=\\\\s]|\\\\$\\\\()\\\\s*(((/\\\\*)|(//))\\\\s?((?:|inline-)css) {0,1000}\\\\*?/?) {0,1000}$\",\"beginCaptures\":{\"1\":{\"name\":\"comment.line\"}},\"end\":\"(`).*\",\"patterns\":[{\"begin\":\"\\\\G()\",\"end\":\"(`)\"},{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.css\"}]},{\"begin\":\"(\\\\$\\\\{)\",\"beginCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"end\":\"(})\",\"endCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.js\"}]}],\"scopeName\":\"inline.es6-css\",\"embeddedLangs\":[\"typescript\",\"css\",\"javascript\"]}"));
var es_tag_css_default = [
	...typescript_default,
	...css_default,
	...javascript_default,
	lang$5
];
//#endregion
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/es-tag-glsl.mjs
const lang$4 = Object.freeze(JSON.parse("{\"fileTypes\":[\"js\",\"jsx\",\"ts\",\"tsx\",\"html\",\"vue\",\"svelte\",\"php\",\"res\"],\"injectTo\":[\"source.ts\",\"source.js\"],\"injectionSelector\":\"L:source.js -comment -string, L:source.js -comment -string, L:source.jsx -comment -string,  L:source.js.jsx -comment -string, L:source.ts -comment -string, L:source.tsx -comment -string, L:source.rescript -comment -string\",\"injections\":{\"L:source\":{\"patterns\":[{\"match\":\"<\",\"name\":\"invalid.illegal.bad-angle-bracket.html\"}]}},\"name\":\"es-tag-glsl\",\"patterns\":[{\"begin\":\"(?i)(\\\\s?/\\\\*\\\\s?((?:|inline-)glsl)\\\\s?\\\\*/\\\\s?)(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.glsl\"},{\"include\":\"inline.es6-htmlx#template\"}]},{\"begin\":\"(?i)(\\\\s*((?:|inline-)glsl))(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.glsl\"},{\"include\":\"inline.es6-htmlx#template\"},{\"include\":\"string.quoted.other.template.js\"}]},{\"begin\":\"(?i)(?<=[(,:=\\\\s]|\\\\$\\\\()\\\\s*(((/\\\\*)|(//))\\\\s?((?:|inline-)glsl) {0,1000}\\\\*?/?) {0,1000}$\",\"beginCaptures\":{\"1\":{\"name\":\"comment.line\"}},\"end\":\"(`).*\",\"patterns\":[{\"begin\":\"\\\\G()\",\"end\":\"(`)\"},{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.glsl\"}]},{\"begin\":\"(\\\\$\\\\{)\",\"beginCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"end\":\"(})\",\"endCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.js\"}]}],\"scopeName\":\"inline.es6-glsl\",\"embeddedLangs\":[\"typescript\",\"glsl\",\"javascript\"]}"));
var es_tag_glsl_default = [
	...typescript_default,
	...glsl_default,
	...javascript_default,
	lang$4
];
//#endregion
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/es-tag-html.mjs
const lang$3 = Object.freeze(JSON.parse("{\"fileTypes\":[\"js\",\"jsx\",\"ts\",\"tsx\",\"html\",\"vue\",\"svelte\",\"php\",\"res\"],\"injectTo\":[\"source.ts\",\"source.js\"],\"injectionSelector\":\"L:source.js -comment -string, L:source.js -comment -string, L:source.jsx -comment -string,  L:source.js.jsx -comment -string, L:source.ts -comment -string, L:source.tsx -comment -string, L:source.rescript -comment -string\",\"injections\":{\"L:source\":{\"patterns\":[{\"match\":\"<\",\"name\":\"invalid.illegal.bad-angle-bracket.html\"}]}},\"name\":\"es-tag-html\",\"patterns\":[{\"begin\":\"(?i)(\\\\s?/\\\\*\\\\s?(html|template|inline-html|inline-template)\\\\s?\\\\*/\\\\s?)(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"text.html.basic\"},{\"include\":\"inline.es6-htmlx#template\"}]},{\"begin\":\"(?i)(\\\\s*(html|template|inline-html|inline-template))(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"text.html.basic\"},{\"include\":\"inline.es6-htmlx#template\"},{\"include\":\"string.quoted.other.template.js\"}]},{\"begin\":\"(?i)(?<=[(,:=\\\\s]|\\\\$\\\\()\\\\s*(((/\\\\*)|(//))\\\\s?(html|template|inline-html|inline-template) {0,1000}\\\\*?/?) {0,1000}$\",\"beginCaptures\":{\"1\":{\"name\":\"comment.line\"}},\"end\":\"(`).*\",\"patterns\":[{\"begin\":\"\\\\G()\",\"end\":\"(`)\"},{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"text.html.basic\"}]},{\"begin\":\"(\\\\$\\\\{)\",\"beginCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"end\":\"(})\",\"endCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.js\"}]},{\"begin\":\"(\\\\$\\\\(`)\",\"beginCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"end\":\"(`\\\\))\",\"endCaptures\":{\"1\":{\"name\":\"entity.name.tag\"}},\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.js\"}]}],\"scopeName\":\"inline.es6-html\",\"embeddedLangs\":[\"typescript\",\"html\",\"javascript\"]}"));
var es_tag_html_default = [
	...typescript_default,
	...html_default,
	...javascript_default,
	lang$3
];
//#endregion
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/es-tag-sql.mjs
const lang$2 = Object.freeze(JSON.parse("{\"fileTypes\":[\"js\",\"jsx\",\"ts\",\"tsx\",\"html\",\"vue\",\"svelte\",\"php\",\"res\"],\"injectTo\":[\"source.ts\",\"source.js\"],\"injectionSelector\":\"L:source.js -comment -string, L:source.jsx -comment -string,  L:source.js.jsx -comment -string, L:source.ts -comment -string, L:source.tsx -comment -string, L:source.rescript -comment -string\",\"injections\":{\"L:source\":{\"patterns\":[{\"match\":\"<\",\"name\":\"invalid.illegal.bad-angle-bracket.html\"}]}},\"name\":\"es-tag-sql\",\"patterns\":[{\"begin\":\"(?i)\\\\b(\\\\w+\\\\.sql)\\\\s*(`)\",\"beginCaptures\":{\"1\":{\"name\":\"variable.parameter\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.ts#string-character-escape\"},{\"include\":\"source.sql\"},{\"include\":\"source.plpgsql.postgres\"},{\"match\":\".\"}]},{\"begin\":\"(?i)(\\\\s?/?\\\\*?\\\\s?((?:|inline-)sql)\\\\s?\\\\*?/?\\\\s?)(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.ts#string-character-escape\"},{\"include\":\"source.sql\"},{\"include\":\"source.plpgsql.postgres\"},{\"match\":\".\"}]},{\"begin\":\"(?i)(?<=[(,:=\\\\s]|\\\\$\\\\()\\\\s*(((/\\\\*)|(//))\\\\s?((?:|inline-)sql) {0,1000}\\\\*?/?) {0,1000}$\",\"beginCaptures\":{\"1\":{\"name\":\"comment.line\"}},\"end\":\"(`)\",\"patterns\":[{\"begin\":\"\\\\G()\",\"end\":\"(`)\"},{\"include\":\"source.ts#template-substitution-element\"},{\"include\":\"source.ts#string-character-escape\"},{\"include\":\"source.sql\"},{\"include\":\"source.plpgsql.postgres\"},{\"match\":\".\"}]}],\"scopeName\":\"inline.es6-sql\",\"embeddedLangs\":[\"typescript\",\"sql\"]}"));
var es_tag_sql_default = [
	...typescript_default,
	...sql_default,
	lang$2
];
//#endregion
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/es-tag-xml.mjs
const lang$1 = Object.freeze(JSON.parse("{\"fileTypes\":[\"js\",\"jsx\",\"ts\",\"tsx\",\"html\",\"vue\",\"svelte\",\"php\",\"res\"],\"injectTo\":[\"source.ts\",\"source.js\"],\"injectionSelector\":\"L:source.js -comment -string, L:source.js -comment -string, L:source.jsx -comment -string,  L:source.js.jsx -comment -string, L:source.ts -comment -string, L:source.tsx -comment -string, L:source.rescript -comment -string\",\"injections\":{\"L:source\":{\"patterns\":[{\"match\":\"<\",\"name\":\"invalid.illegal.bad-angle-bracket.html\"}]}},\"name\":\"es-tag-xml\",\"patterns\":[{\"begin\":\"(?i)(\\\\s?/\\\\*\\\\s?(xml|svg|inline-svg|inline-xml)\\\\s?\\\\*/\\\\s?)(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"text.xml\"}]},{\"begin\":\"(?i)(\\\\s*((?:|inline-)xml))(`)\",\"beginCaptures\":{\"1\":{\"name\":\"comment.block\"}},\"end\":\"(`)\",\"patterns\":[{\"include\":\"text.xml\"}]},{\"begin\":\"(?i)(?<=[(,:=\\\\s]|\\\\$\\\\()\\\\s*(((/\\\\*)|(//))\\\\s?(xml|svg|inline-svg|inline-xml) {0,1000}\\\\*?/?) {0,1000}$\",\"beginCaptures\":{\"1\":{\"name\":\"comment.line\"}},\"end\":\"(`).*\",\"patterns\":[{\"begin\":\"\\\\G()\",\"end\":\"(`)\"},{\"include\":\"text.xml\"}]}],\"scopeName\":\"inline.es6-xml\",\"embeddedLangs\":[\"xml\"]}"));
var es_tag_xml_default = [...xml_default, lang$1];
//#endregion
//#region node_modules/.pnpm/@shikijs+langs@3.23.0/node_modules/@shikijs/langs/dist/ts-tags.mjs
const lang = Object.freeze(JSON.parse("{\"displayName\":\"TypeScript with Tags\",\"name\":\"ts-tags\",\"patterns\":[{\"include\":\"source.ts\"}],\"scopeName\":\"source.ts.tags\",\"embeddedLangs\":[\"typescript\",\"es-tag-css\",\"es-tag-glsl\",\"es-tag-html\",\"es-tag-sql\",\"es-tag-xml\"],\"aliases\":[\"lit\"]}"));
var ts_tags_default = [
	...typescript_default,
	...es_tag_css_default,
	...es_tag_glsl_default,
	...es_tag_html_default,
	...es_tag_sql_default,
	...es_tag_xml_default,
	lang
];
//#endregion
export { ts_tags_default as default };
