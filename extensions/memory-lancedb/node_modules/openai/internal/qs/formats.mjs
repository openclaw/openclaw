export const default_format = 'RFC3986';
export const default_formatter = (v) => String(v);
export const formatters = {
    RFC1738: (v) => String(v).replace(/%20/g, '+'),
    RFC3986: default_formatter,
};
export const RFC1738 = 'RFC1738';
export const RFC3986 = 'RFC3986';
//# sourceMappingURL=formats.mjs.map