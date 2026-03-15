import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, D as Uint8ArrayType, _ as StringType, s as makeUnexpectedFileContentError, t as BasicParser, y as UINT16_LE } from "./BasicParser-CJDqseT1.js";
import { n as EndOfStreamError, t as fromBuffer } from "./lib-BPhRo--R.js";
import { c as stripNulls } from "./Util-C3ovgFZT.js";
import { i as FourCcToken } from "./APEv2Parser-C7cXS6nR.js";
import { t as ID3v2Parser } from "./ID3v2Parser-DEmuNrAp.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/riff/RiffChunk.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
/**
* Common RIFF chunk header
*/
const Header = {
	len: 8,
	get: (buf, off) => {
		return {
			chunkID: new StringType(4, "latin1").get(buf, off),
			chunkSize: UINT32_LE.get(buf, off + 4)
		};
	}
};
/**
* Token to parse RIFF-INFO tag value
*/
var ListInfoTagValue = class {
	constructor(tagHeader) {
		this.tagHeader = tagHeader;
		this.len = tagHeader.chunkSize;
		this.len += this.len & 1;
	}
	get(buf, off) {
		return new StringType(this.tagHeader.chunkSize, "ascii").get(buf, off);
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wav/WaveChunk.js
var WaveContentError = class extends makeUnexpectedFileContentError("Wave") {};
/**
* Ref: https://msdn.microsoft.com/en-us/library/windows/desktop/dd317599(v=vs.85).aspx
*/
const WaveFormat = {
	PCM: 1,
	ADPCM: 2,
	IEEE_FLOAT: 3,
	MPEG_ADTS_AAC: 5632,
	MPEG_LOAS: 5634,
	RAW_AAC1: 255,
	DOLBY_AC3_SPDIF: 146,
	DVM: 8192,
	RAW_SPORT: 576,
	ESST_AC3: 577,
	DRM: 9,
	DTS2: 8193,
	MPEG: 80
};
const WaveFormatNameMap = {
	[WaveFormat.PCM]: "PCM",
	[WaveFormat.ADPCM]: "ADPCM",
	[WaveFormat.IEEE_FLOAT]: "IEEE_FLOAT",
	[WaveFormat.MPEG_ADTS_AAC]: "MPEG_ADTS_AAC",
	[WaveFormat.MPEG_LOAS]: "MPEG_LOAS",
	[WaveFormat.RAW_AAC1]: "RAW_AAC1",
	[WaveFormat.DOLBY_AC3_SPDIF]: "DOLBY_AC3_SPDIF",
	[WaveFormat.DVM]: "DVM",
	[WaveFormat.RAW_SPORT]: "RAW_SPORT",
	[WaveFormat.ESST_AC3]: "ESST_AC3",
	[WaveFormat.DRM]: "DRM",
	[WaveFormat.DTS2]: "DTS2",
	[WaveFormat.MPEG]: "MPEG"
};
/**
* format chunk; chunk-id is "fmt "
* http://soundfile.sapp.org/doc/WaveFormat/
*/
var Format = class {
	constructor(header) {
		if (header.chunkSize < 16) {throw new WaveContentError("Invalid chunk size");}
		this.len = header.chunkSize;
	}
	get(buf, off) {
		return {
			wFormatTag: UINT16_LE.get(buf, off),
			nChannels: UINT16_LE.get(buf, off + 2),
			nSamplesPerSec: UINT32_LE.get(buf, off + 4),
			nAvgBytesPerSec: UINT32_LE.get(buf, off + 8),
			nBlockAlign: UINT16_LE.get(buf, off + 12),
			wBitsPerSample: UINT16_LE.get(buf, off + 14)
		};
	}
};
/**
* Fact chunk; chunk-id is "fact"
* http://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/WAVE.html
* http://www.recordingblogs.com/wiki/fact-chunk-of-a-wave-file
*/
var FactChunk = class {
	constructor(header) {
		if (header.chunkSize < 4) {throw new WaveContentError("Invalid fact chunk size.");}
		this.len = header.chunkSize;
	}
	get(buf, off) {
		return { dwSampleLength: UINT32_LE.get(buf, off) };
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wav/BwfChunk.js
/**
* Broadcast Audio Extension Chunk
* Ref: https://tech.ebu.ch/docs/tech/tech3285.pdf
*/
const BroadcastAudioExtensionChunk = {
	len: 420,
	get: (uint8array, off) => {
		return {
			description: stripNulls(new StringType(256, "ascii").get(uint8array, off)).trim(),
			originator: stripNulls(new StringType(32, "ascii").get(uint8array, off + 256)).trim(),
			originatorReference: stripNulls(new StringType(32, "ascii").get(uint8array, off + 288)).trim(),
			originationDate: stripNulls(new StringType(10, "ascii").get(uint8array, off + 320)).trim(),
			originationTime: stripNulls(new StringType(8, "ascii").get(uint8array, off + 330)).trim(),
			timeReferenceLow: UINT32_LE.get(uint8array, off + 338),
			timeReferenceHigh: UINT32_LE.get(uint8array, off + 342),
			version: UINT16_LE.get(uint8array, off + 346),
			umid: new Uint8ArrayType(64).get(uint8array, off + 348),
			loudnessValue: UINT16_LE.get(uint8array, off + 412),
			maxTruePeakLevel: UINT16_LE.get(uint8array, off + 414),
			maxMomentaryLoudness: UINT16_LE.get(uint8array, off + 416),
			maxShortTermLoudness: UINT16_LE.get(uint8array, off + 418)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/wav/WaveParser.js
const debug = (0, import_src.default)("music-metadata:parser:RIFF");
/**
* Resource Interchange File Format (RIFF) Parser
*
* WAVE PCM soundfile format
*
* Ref:
* - http://www.johnloomis.org/cpe102/asgn/asgn1/riff.html
* - http://soundfile.sapp.org/doc/WaveFormat
*
* ToDo: Split WAVE part from RIFF parser
*/
var WaveParser = class extends BasicParser {
	constructor() {
		super(...arguments);
		this.blockAlign = 0;
	}
	async parse() {
		const riffHeader = await this.tokenizer.readToken(Header);
		debug(`pos=${this.tokenizer.position}, parse: chunkID=${riffHeader.chunkID}`);
		if (riffHeader.chunkID !== "RIFF") {return;}
		this.metadata.setAudioOnly();
		return this.parseRiffChunk(riffHeader.chunkSize).catch((err) => {
			if (!(err instanceof EndOfStreamError)) {throw err;}
		});
	}
	async parseRiffChunk(chunkSize) {
		const type = await this.tokenizer.readToken(FourCcToken);
		this.metadata.setFormat("container", type);
		switch (type) {
			case "WAVE": return this.readWaveChunk(chunkSize - FourCcToken.len);
			default: throw new WaveContentError(`Unsupported RIFF format: RIFF/${type}`);
		}
	}
	async readWaveChunk(remaining) {
		while (remaining >= Header.len) {
			const header = await this.tokenizer.readToken(Header);
			remaining -= Header.len + header.chunkSize;
			if (header.chunkSize > remaining) {this.metadata.addWarning("Data chunk size exceeds file size");}
			this.header = header;
			debug(`pos=${this.tokenizer.position}, readChunk: chunkID=RIFF/WAVE/${header.chunkID}`);
			switch (header.chunkID) {
				case "LIST":
					await this.parseListTag(header);
					break;
				case "fact":
					this.metadata.setFormat("lossless", false);
					this.fact = await this.tokenizer.readToken(new FactChunk(header));
					break;
				case "fmt ": {
					const fmt = await this.tokenizer.readToken(new Format(header));
					let subFormat = WaveFormatNameMap[fmt.wFormatTag];
					if (!subFormat) {
						debug(`WAVE/non-PCM format=${fmt.wFormatTag}`);
						subFormat = `non-PCM (${fmt.wFormatTag})`;
					}
					this.metadata.setFormat("codec", subFormat);
					this.metadata.setFormat("bitsPerSample", fmt.wBitsPerSample);
					this.metadata.setFormat("sampleRate", fmt.nSamplesPerSec);
					this.metadata.setFormat("numberOfChannels", fmt.nChannels);
					this.metadata.setFormat("bitrate", fmt.nBlockAlign * fmt.nSamplesPerSec * 8);
					this.blockAlign = fmt.nBlockAlign;
					break;
				}
				case "id3 ":
				case "ID3 ": {
					const rst = fromBuffer(await this.tokenizer.readToken(new Uint8ArrayType(header.chunkSize)));
					await new ID3v2Parser().parse(this.metadata, rst, this.options);
					break;
				}
				case "data": {
					if (this.metadata.format.lossless !== false) {this.metadata.setFormat("lossless", true);}
					let chunkSize = header.chunkSize;
					if (this.tokenizer.fileInfo.size) {
						const calcRemaining = this.tokenizer.fileInfo.size - this.tokenizer.position;
						if (calcRemaining < chunkSize) {
							this.metadata.addWarning("data chunk length exceeding file length");
							chunkSize = calcRemaining;
						}
					}
					const numberOfSamples = this.fact ? this.fact.dwSampleLength : chunkSize === 4294967295 ? void 0 : chunkSize / this.blockAlign;
					if (numberOfSamples) {
						this.metadata.setFormat("numberOfSamples", numberOfSamples);
						if (this.metadata.format.sampleRate) {this.metadata.setFormat("duration", numberOfSamples / this.metadata.format.sampleRate);}
					}
					if (this.metadata.format.codec === "ADPCM") {this.metadata.setFormat("bitrate", 352e3);}
					else if (this.metadata.format.sampleRate) {this.metadata.setFormat("bitrate", this.blockAlign * this.metadata.format.sampleRate * 8);}
					await this.tokenizer.ignore(header.chunkSize);
					break;
				}
				case "bext": {
					const bext = await this.tokenizer.readToken(BroadcastAudioExtensionChunk);
					Object.keys(bext).forEach((key) => {
						this.metadata.addTag("exif", `bext.${key}`, bext[key]);
					});
					const bextRemaining = header.chunkSize - BroadcastAudioExtensionChunk.len;
					await this.tokenizer.ignore(bextRemaining);
					break;
				}
				case "\0\0\0\0":
					debug(`Ignore padding chunk: RIFF/${header.chunkID} of ${header.chunkSize} bytes`);
					this.metadata.addWarning(`Ignore chunk: RIFF/${header.chunkID}`);
					await this.tokenizer.ignore(header.chunkSize);
					break;
				default:
					debug(`Ignore chunk: RIFF/${header.chunkID} of ${header.chunkSize} bytes`);
					this.metadata.addWarning(`Ignore chunk: RIFF/${header.chunkID}`);
					await this.tokenizer.ignore(header.chunkSize);
			}
			if (this.header.chunkSize % 2 === 1) {
				debug("Read odd padding byte");
				await this.tokenizer.ignore(1);
			}
		}
	}
	async parseListTag(listHeader) {
		const listType = await this.tokenizer.readToken(new StringType(4, "latin1"));
		debug("pos=%s, parseListTag: chunkID=RIFF/WAVE/LIST/%s", this.tokenizer.position, listType);
		switch (listType) {
			case "INFO": return this.parseRiffInfoTags(listHeader.chunkSize - 4);
			default:
				this.metadata.addWarning(`Ignore chunk: RIFF/WAVE/LIST/${listType}`);
				debug(`Ignoring chunkID=RIFF/WAVE/LIST/${listType}`);
				return this.tokenizer.ignore(listHeader.chunkSize - 4).then();
		}
	}
	async parseRiffInfoTags(chunkSize) {
		while (chunkSize >= 8) {
			const header = await this.tokenizer.readToken(Header);
			const valueToken = new ListInfoTagValue(header);
			const value = await this.tokenizer.readToken(valueToken);
			this.addTag(header.chunkID, stripNulls(value));
			chunkSize -= 8 + valueToken.len;
		}
		if (chunkSize !== 0) {throw new WaveContentError(`Illegal remaining size: ${chunkSize}`);}
	}
	addTag(id, value) {
		this.metadata.addTag("exif", id, value);
	}
};
//#endregion
export { WaveParser };
