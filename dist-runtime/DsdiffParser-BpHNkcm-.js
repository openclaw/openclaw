import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-Bda0Ei4u.js";
import { C as UINT32_LE, D as Uint8ArrayType, E as UINT8, S as UINT32_BE, _ as StringType, m as INT64_BE, s as makeUnexpectedFileContentError, t as BasicParser, v as UINT16_BE } from "./BasicParser-CSRv9UUV.js";
import { t as fromBuffer } from "./lib-CbsdtN_V.js";
import { i as FourCcToken } from "./APEv2Parser-BjYRB_Uk.js";
import { t as ID3v2Parser } from "./ID3v2Parser-CFsiIDk-.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/dsdiff/DsdiffToken.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
/**
* DSDIFF chunk header
* The data-size encoding is deviating from EA-IFF 85
* Ref: http://www.sonicstudio.com/pdf/dsd/DSDIFF_1.5_Spec.pdf
*/
const ChunkHeader64 = {
	len: 12,
	get: (buf, off) => {
		return {
			chunkID: FourCcToken.get(buf, off),
			chunkSize: INT64_BE.get(buf, off + 4)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/dsdiff/DsdiffParser.js
const debug = (0, import_src.default)("music-metadata:parser:aiff");
var DsdiffContentParseError = class extends makeUnexpectedFileContentError("DSDIFF") {};
/**
* DSDIFF - Direct Stream Digital Interchange File Format (Phillips)
*
* Ref:
* - http://www.sonicstudio.com/pdf/dsd/DSDIFF_1.5_Spec.pdf
*/
var DsdiffParser = class extends BasicParser {
	async parse() {
		const header = await this.tokenizer.readToken(ChunkHeader64);
		if (header.chunkID !== "FRM8") {throw new DsdiffContentParseError("Unexpected chunk-ID");}
		this.metadata.setAudioOnly();
		const type = (await this.tokenizer.readToken(FourCcToken)).trim();
		switch (type) {
			case "DSD":
				this.metadata.setFormat("container", `DSDIFF/${type}`);
				this.metadata.setFormat("lossless", true);
				return this.readFmt8Chunks(header.chunkSize - BigInt(FourCcToken.len));
			default: throw new DsdiffContentParseError(`Unsupported DSDIFF type: ${type}`);
		}
	}
	async readFmt8Chunks(remainingSize) {
		while (remainingSize >= ChunkHeader64.len) {
			const chunkHeader = await this.tokenizer.readToken(ChunkHeader64);
			debug(`Chunk id=${chunkHeader.chunkID}`);
			await this.readData(chunkHeader);
			remainingSize -= BigInt(ChunkHeader64.len) + chunkHeader.chunkSize;
		}
	}
	async readData(header) {
		debug(`Reading data of chunk[ID=${header.chunkID}, size=${header.chunkSize}]`);
		const p0 = this.tokenizer.position;
		switch (header.chunkID.trim()) {
			case "FVER":
				debug(`DSDIFF version=${await this.tokenizer.readToken(UINT32_LE)}`);
				break;
			case "PROP":
				if (await this.tokenizer.readToken(FourCcToken) !== "SND ") {throw new DsdiffContentParseError("Unexpected PROP-chunk ID");}
				await this.handleSoundPropertyChunks(header.chunkSize - BigInt(FourCcToken.len));
				break;
			case "ID3": {
				const rst = fromBuffer(await this.tokenizer.readToken(new Uint8ArrayType(Number(header.chunkSize))));
				await new ID3v2Parser().parse(this.metadata, rst, this.options);
				break;
			}
			case "DSD":
				if (this.metadata.format.numberOfChannels) {this.metadata.setFormat("numberOfSamples", Number(header.chunkSize * BigInt(8) / BigInt(this.metadata.format.numberOfChannels)));}
				if (this.metadata.format.numberOfSamples && this.metadata.format.sampleRate) {this.metadata.setFormat("duration", this.metadata.format.numberOfSamples / this.metadata.format.sampleRate);}
				break;
			default:
				debug(`Ignore chunk[ID=${header.chunkID}, size=${header.chunkSize}]`);
				break;
		}
		const remaining = header.chunkSize - BigInt(this.tokenizer.position - p0);
		if (remaining > 0) {
			debug(`After Parsing chunk, remaining ${remaining} bytes`);
			await this.tokenizer.ignore(Number(remaining));
		}
	}
	async handleSoundPropertyChunks(remainingSize) {
		debug(`Parsing sound-property-chunks, remainingSize=${remainingSize}`);
		while (remainingSize > 0) {
			const sndPropHeader = await this.tokenizer.readToken(ChunkHeader64);
			debug(`Sound-property-chunk[ID=${sndPropHeader.chunkID}, size=${sndPropHeader.chunkSize}]`);
			const p0 = this.tokenizer.position;
			switch (sndPropHeader.chunkID.trim()) {
				case "FS": {
					const sampleRate = await this.tokenizer.readToken(UINT32_BE);
					this.metadata.setFormat("sampleRate", sampleRate);
					break;
				}
				case "CHNL": {
					const numChannels = await this.tokenizer.readToken(UINT16_BE);
					this.metadata.setFormat("numberOfChannels", numChannels);
					await this.handleChannelChunks(sndPropHeader.chunkSize - BigInt(UINT16_BE.len));
					break;
				}
				case "CMPR": {
					const compressionIdCode = (await this.tokenizer.readToken(FourCcToken)).trim();
					const count = await this.tokenizer.readToken(UINT8);
					const compressionName = await this.tokenizer.readToken(new StringType(count, "ascii"));
					if (compressionIdCode === "DSD") {
						this.metadata.setFormat("lossless", true);
						this.metadata.setFormat("bitsPerSample", 1);
					}
					this.metadata.setFormat("codec", `${compressionIdCode} (${compressionName})`);
					break;
				}
				case "ABSS":
					debug(`ABSS ${await this.tokenizer.readToken(UINT16_BE)}:${await this.tokenizer.readToken(UINT8)}:${await this.tokenizer.readToken(UINT8)}.${await this.tokenizer.readToken(UINT32_BE)}`);
					break;
				case "LSCO":
					debug(`LSCO lsConfig=${await this.tokenizer.readToken(UINT16_BE)}`);
					break;
				default:
					debug(`Unknown sound-property-chunk[ID=${sndPropHeader.chunkID}, size=${sndPropHeader.chunkSize}]`);
					await this.tokenizer.ignore(Number(sndPropHeader.chunkSize));
			}
			const remaining = sndPropHeader.chunkSize - BigInt(this.tokenizer.position - p0);
			if (remaining > 0) {
				debug(`After Parsing sound-property-chunk ${sndPropHeader.chunkSize}, remaining ${remaining} bytes`);
				await this.tokenizer.ignore(Number(remaining));
			}
			remainingSize -= BigInt(ChunkHeader64.len) + sndPropHeader.chunkSize;
			debug(`Parsing sound-property-chunks, remainingSize=${remainingSize}`);
		}
		if (this.metadata.format.lossless && this.metadata.format.sampleRate && this.metadata.format.numberOfChannels && this.metadata.format.bitsPerSample) {
			const bitrate = this.metadata.format.sampleRate * this.metadata.format.numberOfChannels * this.metadata.format.bitsPerSample;
			this.metadata.setFormat("bitrate", bitrate);
		}
	}
	async handleChannelChunks(remainingSize) {
		debug(`Parsing channel-chunks, remainingSize=${remainingSize}`);
		const channels = [];
		while (remainingSize >= FourCcToken.len) {
			const channelId = await this.tokenizer.readToken(FourCcToken);
			debug(`Channel[ID=${channelId}]`);
			channels.push(channelId);
			remainingSize -= BigInt(FourCcToken.len);
		}
		debug(`Channels: ${channels.join(", ")}`);
		return channels;
	}
};
//#endregion
export { DsdiffParser };
