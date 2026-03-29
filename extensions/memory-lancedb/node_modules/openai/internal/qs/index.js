"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formats = exports.stringify = void 0;
const formats_1 = require("./formats.js");
const formats = {
    formatters: formats_1.formatters,
    RFC1738: formats_1.RFC1738,
    RFC3986: formats_1.RFC3986,
    default: formats_1.default_format,
};
exports.formats = formats;
var stringify_1 = require("./stringify.js");
Object.defineProperty(exports, "stringify", { enumerable: true, get: function () { return stringify_1.stringify; } });
//# sourceMappingURL=index.js.map