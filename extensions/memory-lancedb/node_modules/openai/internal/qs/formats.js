"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RFC3986 = exports.RFC1738 = exports.formatters = exports.default_formatter = exports.default_format = void 0;
exports.default_format = 'RFC3986';
const default_formatter = (v) => String(v);
exports.default_formatter = default_formatter;
exports.formatters = {
    RFC1738: (v) => String(v).replace(/%20/g, '+'),
    RFC3986: exports.default_formatter,
};
exports.RFC1738 = 'RFC1738';
exports.RFC3986 = 'RFC3986';
//# sourceMappingURL=formats.js.map