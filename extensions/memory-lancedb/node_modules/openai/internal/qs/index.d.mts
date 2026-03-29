declare const formats: {
    formatters: Record<import("./types").Format, (str: PropertyKey) => string>;
    RFC1738: string;
    RFC3986: string;
    default: import("./types").Format;
};
export { stringify } from "./stringify.mjs";
export { formats };
export type { DefaultDecoder, DefaultEncoder, Format, ParseOptions, StringifyOptions } from "./types.mjs";
//# sourceMappingURL=index.d.mts.map