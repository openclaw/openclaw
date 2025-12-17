/* codepage.js (C) 2013-present SheetJS -- http://sheetjs.com */
// TypeScript Version: 2.2

/** Codepage index type (integer or string representation) */
export type CP$Index = number | string;

/* Individual codepage converter */
export interface CP$Conv {
	enc: {[n: string]: number; };
	dec: {[n: number]: string; };
}

/** Encode input type (string, array of characters, Buffer) */
export type CP$String = string | string[] | Uint8Array;

/** Encode output / decode input type */
export type CP$Data = string | number[] | Uint8Array;

/** General utilities */
export interface CP$Utils {
	decode(cp: CP$Index, data: CP$Data): string;
	encode(cp: CP$Index, data: CP$String, opts?: any): CP$Data;
	hascp(n: number): boolean;
	magic: {[cp: string]: string};
}

/* note: TS cannot export top-level indexer, hence default workaround */
export interface CP$Module {
	/** Version string */
	version: string;

	/** Utility Functions */
	utils: CP$Utils;

	/** Codepage Converters */
	[cp: number]: CP$Conv;
}
export const cptable: CP$Module;
export default cptable;
