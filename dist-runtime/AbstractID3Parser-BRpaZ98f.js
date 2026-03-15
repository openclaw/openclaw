import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-Bda0Ei4u.js";
import { t as BasicParser } from "./BasicParser-CSRv9UUV.js";
import { n as EndOfStreamError } from "./lib-CbsdtN_V.js";
import { r as ID3v2Header } from "./ID3v2Token-DJdxMJS5.js";
import { n as ID3v1Parser } from "./ID3v1Parser-BQVgS29p.js";
import { t as ID3v2Parser } from "./ID3v2Parser-CFsiIDk-.js";
const debug = (0, (/* @__PURE__ */ __toESM(require_src(), 1)).default)("music-metadata:parser:ID3");
/**
* Abstract parser which tries take ID3v2 and ID3v1 headers.
*/
var AbstractID3Parser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.id3parser = new ID3v2Parser();
	}
	static async startsWithID3v2Header(tokenizer) {
		return (await tokenizer.peekToken(ID3v2Header)).fileIdentifier === "ID3";
	}
	async parse() {
		try {
			await this.parseID3v2();
		} catch (err) {
			if (err instanceof EndOfStreamError) {debug("End-of-stream");}
			else {throw err;}
		}
	}
	finalize() {}
	async parseID3v2() {
		await this.tryReadId3v2Headers();
		debug("End of ID3v2 header, go to MPEG-parser: pos=%s", this.tokenizer.position);
		await this.postId3v2Parse();
		if (this.options.skipPostHeaders && this.metadata.hasAny()) {this.finalize();}
		else {
			await new ID3v1Parser(this.metadata, this.tokenizer, this.options).parse();
			this.finalize();
		}
	}
	async tryReadId3v2Headers() {
		if ((await this.tokenizer.peekToken(ID3v2Header)).fileIdentifier === "ID3") {
			debug("Found ID3v2 header, pos=%s", this.tokenizer.position);
			await this.id3parser.parse(this.metadata, this.tokenizer, this.options);
			return this.tryReadId3v2Headers();
		}
	}
};
//#endregion
export { AbstractID3Parser as t };
