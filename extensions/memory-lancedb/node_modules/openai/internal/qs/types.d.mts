export type Format = 'RFC1738' | 'RFC3986';
export type DefaultEncoder = (str: any, defaultEncoder?: any, charset?: string) => string;
export type DefaultDecoder = (str: string, decoder?: any, charset?: string) => string;
export type BooleanOptional = boolean | undefined;
export type StringifyBaseOptions = {
    delimiter?: string;
    allowDots?: boolean;
    encodeDotInKeys?: boolean;
    strictNullHandling?: boolean;
    skipNulls?: boolean;
    encode?: boolean;
    encoder?: (str: any, defaultEncoder: DefaultEncoder, charset: string, type: 'key' | 'value', format?: Format) => string;
    filter?: Array<PropertyKey> | ((prefix: PropertyKey, value: any) => any);
    arrayFormat?: 'indices' | 'brackets' | 'repeat' | 'comma';
    indices?: boolean;
    sort?: ((a: PropertyKey, b: PropertyKey) => number) | null;
    serializeDate?: (d: Date) => string;
    format?: 'RFC1738' | 'RFC3986';
    formatter?: (str: PropertyKey) => string;
    encodeValuesOnly?: boolean;
    addQueryPrefix?: boolean;
    charset?: 'utf-8' | 'iso-8859-1';
    charsetSentinel?: boolean;
    allowEmptyArrays?: boolean;
    commaRoundTrip?: boolean;
};
export type StringifyOptions = StringifyBaseOptions;
export type ParseBaseOptions = {
    comma?: boolean;
    delimiter?: string | RegExp;
    depth?: number | false;
    decoder?: (str: string, defaultDecoder: DefaultDecoder, charset: string, type: 'key' | 'value') => any;
    arrayLimit?: number;
    parseArrays?: boolean;
    plainObjects?: boolean;
    allowPrototypes?: boolean;
    allowSparse?: boolean;
    parameterLimit?: number;
    strictDepth?: boolean;
    strictNullHandling?: boolean;
    ignoreQueryPrefix?: boolean;
    charset?: 'utf-8' | 'iso-8859-1';
    charsetSentinel?: boolean;
    interpretNumericEntities?: boolean;
    allowEmptyArrays?: boolean;
    duplicates?: 'combine' | 'first' | 'last';
    allowDots?: boolean;
    decodeDotInKeys?: boolean;
};
export type ParseOptions = ParseBaseOptions;
export type ParsedQs = {
    [key: string]: undefined | string | string[] | ParsedQs | ParsedQs[];
};
export type NonNullableProperties<T> = {
    [K in keyof T]-?: Exclude<T[K], undefined | null>;
};
//# sourceMappingURL=types.d.mts.map