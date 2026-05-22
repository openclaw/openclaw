import { a as __require, s as __toESM, t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#region node_modules/simple-yenc/dist/esm.js
const t = (t, n = 4294967295, e = 79764919) => {
	const r = new Int32Array(256);
	let o, s, i, c = n;
	for (o = 0; o < 256; o++) {
		for (i = o << 24, s = 8; s > 0; --s) i = 2147483648 & i ? i << 1 ^ e : i << 1;
		r[o] = i;
	}
	for (o = 0; o < t.length; o++) c = c << 8 ^ r[255 & (c >> 24 ^ t[o])];
	return c;
}, e = (n, e = t) => {
	const r = (t) => new Uint8Array(t.length / 2).map(((n, e) => parseInt(t.substring(2 * e, 2 * (e + 1)), 16))), o = (t) => r(t)[0], s = /* @__PURE__ */ new Map();
	[
		,
		8364,
		,
		8218,
		402,
		8222,
		8230,
		8224,
		8225,
		710,
		8240,
		352,
		8249,
		338,
		,
		381,
		,
		,
		8216,
		8217,
		8220,
		8221,
		8226,
		8211,
		8212,
		732,
		8482,
		353,
		8250,
		339,
		,
		382,
		376
	].forEach(((t, n) => s.set(t, n)));
	const i = new Uint8Array(n.length);
	let c, a, l, f = !1, g = 0, h = 42, p = n.length > 13 && "dynEncode" === n.substring(0, 9), u = 0;
	p && (u = 11, a = o(n.substring(9, u)), a <= 1 && (u += 2, h = o(n.substring(11, u))), 1 === a && (u += 8, l = ((t) => new DataView(r(t).buffer).getInt32(0, !0))(n.substring(13, u))));
	const d = 256 - h;
	for (let t = u; t < n.length; t++) if (c = n.charCodeAt(t), 61 !== c || f) {
		if (92 === c && t < n.length - 5 && p) {
			const e = n.charCodeAt(t + 1);
			117 !== e && 85 !== e || (c = parseInt(n.substring(t + 2, t + 6), 16), t += 5);
		}
		if (c > 255) {
			const t = s.get(c);
			t && (c = t + 127);
		}
		f && (f = !1, c -= 64), i[g++] = c < h && c > 0 ? c + d : c - h;
	} else f = !0;
	const m = i.subarray(0, g);
	if (p && 1 === a) {
		const t = e(m);
		if (t !== l) {
			const n = "Decode failed crc32 validation";
			throw console.error("`simple-yenc`\n", n + "\n", "Expected: " + l + "; Got: " + t + "\n", "Visit https://github.com/eshaz/simple-yenc for more information"), Error(n);
		}
	}
	return m;
};
//#endregion
//#region node_modules/@wasm-audio-decoders/common/src/WASMAudioDecoderCommon.js
function WASMAudioDecoderCommon() {
	const uint8Array = Uint8Array;
	const float32Array = Float32Array;
	if (!WASMAudioDecoderCommon.modules) Object.defineProperties(WASMAudioDecoderCommon, {
		modules: { value: /* @__PURE__ */ new WeakMap() },
		setModule: { value(Ref, module) {
			WASMAudioDecoderCommon.modules.set(Ref, Promise.resolve(module));
		} },
		getModule: { value(Ref, wasmString) {
			let module = WASMAudioDecoderCommon.modules.get(Ref);
			if (!module) {
				if (!wasmString) {
					wasmString = Ref.wasm;
					module = WASMAudioDecoderCommon.inflateDynEncodeString(wasmString).then((data) => WebAssembly.compile(data));
				} else module = WebAssembly.compile(e(wasmString));
				WASMAudioDecoderCommon.modules.set(Ref, module);
			}
			return module;
		} },
		concatFloat32: { value(buffers, length) {
			let ret = new float32Array(length), i = 0, offset = 0;
			while (i < buffers.length) {
				ret.set(buffers[i], offset);
				offset += buffers[i++].length;
			}
			return ret;
		} },
		getDecodedAudio: { value: (errors, channelData, samplesDecoded, sampleRate, bitDepth) => ({
			errors,
			channelData,
			samplesDecoded,
			sampleRate,
			bitDepth
		}) },
		getDecodedAudioMultiChannel: { value(errors, input, channelsDecoded, samplesDecoded, sampleRate, bitDepth) {
			let channelData = [], i, j;
			for (i = 0; i < channelsDecoded; i++) {
				const channel = [];
				for (j = 0; j < input.length;) channel.push(input[j++][i] || []);
				channelData.push(WASMAudioDecoderCommon.concatFloat32(channel, samplesDecoded));
			}
			return WASMAudioDecoderCommon.getDecodedAudio(errors, channelData, samplesDecoded, sampleRate, bitDepth);
		} },
		inflateDynEncodeString: { value(source) {
			source = e(source);
			return new Promise((resolve) => {
				const puffString = String.raw`dynEncode012804c7886d()((()>+*§§)§,§§§§)§+§§§)§+.-()(*)-+)(.7*§)i¸¸,3§(i¸¸,3/G+.¡*(,(,3+)2å:-),§H(P*DI*H(P*@I++hH)H*r,hH(H(P*<J,i)^*<H,H(P*4U((I-H(H*i0J,^*DH+H-H*I+H,I*4)33H(H*H)^*DH(H+H)^*@H+i§H)i§3æ*).§K(iHI/+§H,iHn,§H+i(H+i(rCJ0I,H*I-+hH,,hH(H-V)(i)J.H.W)(i)c)(H,i)I,H-i*I-4)33i(I.*hH(V)(H+n5(H(i*I-i(I,i)I.+hH,i*J+iHn,hi(I-i*I,+hH,H/H-c)(H,iFn,hi(I,+hH,H0n5-H*V)(J(,hH/H(i)J(H(V)(J(i)c)(H)H(i)H,c)(3H*i*I*H,i)I,4(3(-H(H,W)(H-I-H,i*I,4)3(3(3H,H-I1H+I,H.i)H1V)(J.i(v5(33H.-H(H,i(c)(H,i*I,4)333)-§i*I*+§H*iHn,hi73H,H(i)8(H+J+H)P*(H*V)(J-r,§H)P*,H.i)H+H,i)V)(-H*i*I*H+i)I+H-H.I.H,H-i)I,4)333Ã+)-§iø7i(^*(iü7I,*h+hH+iDn,h*hilI+i)I,+hH+,hH+iô7H,c)(i)H+i´8W)(H,I,H+i*I+4)-+hH(H)8*J-i(p5.*h*h*hH-i')u,hH(P*(J+,hH(P*0J,H(P*,n50H+H,H-b((3H(P*0i)I.4)3H-i¨*n5*H-iÅ*s,hi73H-i)J+V)&+I,H(H+V)æ,8(I.H(H*8*J-i(p51H-i)J+i¸7V)(H(H+iø7V)(8(J/H(P*0J+s,hi73H+H,H.J,I.H(P*(m5(H.H(P*,s5.+hH,m5*H(P*(J.H+H.H+H/U((b((H(H(P*0i)J+^*0H,i)I,4(3(3H(H.^*03H-i¨*o5)33i(73(3(3-H,H+i)c)(H,i*I,H+i)I+4)33i)I-3H-3!2)0§K(i2J,L(H,H(^*(H,H*^*4H,i(^*0H,i(^*DH,j(_*<H,H)P*(^*,H,H+P*(^*8*h*h+hH,i)8(I3i§I**h*h*h*h*h*h*hH,i*8(6+(),03H,j(_*@i*I-H,P*<J.i,J(H,P*8J/s50H,H.i+J0^*<i¦I*H.H,P*4J1J.U(*H.U((J2i')o5/H.U()I.H,H(^*<H0H1U((H.i0J.i§i0i')o5/H/H.H2J*H(J.q50H,P*0J/H*I-H,P*(J0,hH,P*,H-q,hi)I-423+hH*m5+H/H0H(H1U((b((H/i)I/H(i)I(H*i)I*4(3(3H,H.^*<H,H-^*04*3iØ1U((5+i(I(i¨7i1^*(i$6iè1^*(i°7iè6^*(i¬7iÈ6^*(+hH(iÈ*n,hiÈ*I(+hH(i¨,n,hi¨,I(+hH(iØ,n,hiØ,I(+hH(iè,o,hH,i-H(i0c)(H(i*I(4)33iè1i1H,i-iÈ*8)Bi(I(+hH(ido,hH,i-H(i-c)(H(i*I(4)33iÈ6iè6H,i-iF8)BiØ1i)b((41-H,i-H(i/c)(H(i*I(4)3(3(-H,i-H(i1c)(H(i*I(4)3(3(-H,i-H(i0c)(H(i*I(4)3(3(3H,H/^*0H,H(^*<3i(I*4*3H,H,i¸)^*TH,H,iø-^*PH,H,iX^*LH,H,i(^*HH,i-8(I(H,i-8(I-i¥I*H,i,8(I.H(iErH-iEr5)H(i©*I1H-i)I0i(i;H.i,J(i(H(i(rCJ(J*H*i;sCI*i¨1I-H(I/+hH/,hH,i-H-V)(i)H,i+8(c)(H/i)I/H-i*I-H*i)I*4)-H(i)i¨1I/+hH(H*o,hH,i-H/V)(i)i(c)(H/i*I/H(i)I(4)33i¤I*H,iø-H,i¸)H,i-i;8)5+H0H1I2i(I-+hH-H2p,hH,H,iP8*J*i(p5-H*i7u,hH,i-H-i)H*c)(H-i)I-4*3i(I/i+I.i+I(*h*h*hH*i86*(*)3H-m,hi£I*403H-i)H,W)-I/i*I(4)3i3I.i/I(3H2H,H(8(H.J(H-J.p,hi¢I*4.3H,i-H-i)I*+hH(,hH*H/c)(H*i*I*H(i)I(4)-H.I-4+3(3(33H,W)1m,hiI*4,3H,iø-H,i¸)H,i-H18)J(,hi¡I*H(i(p5,H1H,V)ú-H,V)ø-o5,3H,i(H,iXH,i-H1i)H08)J(,hi I*H(i(p5,H0H,V)H,V)o5,3H,H,iPH,iH8+I*4+3(3(3H,i$6i¬78+I*3H*H3m5(3i)I-H*i(r5)3H)H,P*0^*(H+H,P*<^*(H*I-3H,i2L(H-33Á)+(i¨03b+(,(-(.(/(0(1(2(3(5(7(9(;(?(C(G(K(S([(c(k({(((«(Ë(ë((*)(iø03O)()()()(*(*(*(*(+(+(+(+(,(,(,(,(-(-(-(-(i¨13M8(9(:(((0(/(1(.(2(-(3(,(4(+(5(*(6()(7(T7*S7US0U `;
				WASMAudioDecoderCommon.getModule(WASMAudioDecoderCommon, puffString).then((wasm) => WebAssembly.instantiate(wasm, {})).then(({ exports }) => {
					const instanceExports = new Map(Object.entries(exports));
					const puff = instanceExports.get("puff");
					const memory = instanceExports.get("memory")["buffer"];
					const dataArray = new uint8Array(memory);
					const heapView = new DataView(memory);
					let heapPos = instanceExports.get("__heap_base");
					const sourceLength = source.length;
					const sourceLengthPtr = heapPos;
					heapPos += 4;
					heapView.setInt32(sourceLengthPtr, sourceLength, true);
					const sourcePtr = heapPos;
					heapPos += sourceLength;
					dataArray.set(source, sourcePtr);
					const destLengthPtr = heapPos;
					heapPos += 4;
					heapView.setInt32(destLengthPtr, dataArray.byteLength - heapPos, true);
					puff(heapPos, destLengthPtr, sourcePtr, sourceLengthPtr);
					resolve(dataArray.slice(heapPos, heapPos + heapView.getInt32(destLengthPtr, true)));
				});
			});
		} }
	});
	Object.defineProperty(this, "wasm", {
		enumerable: true,
		get: () => this._wasm
	});
	this.getOutputChannels = (outputData, channelsDecoded, samplesDecoded) => {
		let output = [], i = 0;
		while (i < channelsDecoded) output.push(outputData.slice(i * samplesDecoded, i++ * samplesDecoded + samplesDecoded));
		return output;
	};
	this.allocateTypedArray = (len, TypedArray, setPointer = true) => {
		const ptr = this._wasm.malloc(TypedArray.BYTES_PER_ELEMENT * len);
		if (setPointer) this._pointers.add(ptr);
		return {
			ptr,
			len,
			buf: new TypedArray(this._wasm.HEAP, ptr, len)
		};
	};
	this.free = () => {
		this._pointers.forEach((ptr) => {
			this._wasm.free(ptr);
		});
		this._pointers.clear();
	};
	this.codeToString = (ptr) => {
		const characters = [], heap = new Uint8Array(this._wasm.HEAP);
		for (let character = heap[ptr]; character !== 0; character = heap[++ptr]) characters.push(character);
		return String.fromCharCode.apply(null, characters);
	};
	this.addError = (errors, message, frameLength, frameNumber, inputBytes, outputSamples) => {
		errors.push({
			message,
			frameLength,
			frameNumber,
			inputBytes,
			outputSamples
		});
	};
	this.instantiate = (_EmscriptenWASM, _module) => {
		if (_module) WASMAudioDecoderCommon.setModule(_EmscriptenWASM, _module);
		this._wasm = new _EmscriptenWASM(WASMAudioDecoderCommon).instantiate();
		this._pointers = /* @__PURE__ */ new Set();
		return this._wasm.ready.then(() => this);
	};
}
//#endregion
//#region node_modules/@wasm-audio-decoders/common/src/WASMAudioDecoderWorker.js
var import_node = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Copyright 2020 Google LLC
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*     http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*/
	const URL$1 = __require("url");
	const VM = __require("vm");
	const threads = __require("worker_threads");
	const WORKER = Symbol.for("worker");
	const EVENTS = Symbol.for("events");
	var EventTarget = class {
		constructor() {
			Object.defineProperty(this, EVENTS, { value: /* @__PURE__ */ new Map() });
		}
		dispatchEvent(event) {
			event.target = event.currentTarget = this;
			if (this["on" + event.type]) try {
				this["on" + event.type](event);
			} catch (err) {
				console.error(err);
			}
			const list = this[EVENTS].get(event.type);
			if (list == null) return;
			list.forEach((handler) => {
				try {
					handler.call(this, event);
				} catch (err) {
					console.error(err);
				}
			});
		}
		addEventListener(type, fn) {
			let events = this[EVENTS].get(type);
			if (!events) this[EVENTS].set(type, events = []);
			events.push(fn);
		}
		removeEventListener(type, fn) {
			let events = this[EVENTS].get(type);
			if (events) {
				const index = events.indexOf(fn);
				if (index !== -1) events.splice(index, 1);
			}
		}
	};
	function Event(type, target) {
		this.type = type;
		this.timeStamp = Date.now();
		this.target = this.currentTarget = this.data = null;
	}
	module.exports = threads.isMainThread ? mainThread() : workerThread();
	const baseUrl = URL$1.pathToFileURL(process.cwd() + "/");
	function mainThread() {
		/**
		* A web-compatible Worker implementation atop Node's worker_threads.
		*  - uses DOM-style events (Event.data, Event.type, etc)
		*  - supports event handler properties (worker.onmessage)
		*  - Worker() constructor accepts a module URL
		*  - accepts the {type:'module'} option
		*  - emulates WorkerGlobalScope within the worker
		* @param {string} url  The URL or module specifier to load
		* @param {object} [options]  Worker construction options
		* @param {string} [options.name]  Available as `self.name` within the Worker
		* @param {string} [options.type="classic"]  Pass "module" to create a Module Worker.
		*/
		class Worker extends EventTarget {
			constructor(url, options) {
				super();
				const { name, type } = options || {};
				url += "";
				let mod;
				if (/^data:/.test(url)) mod = url;
				else mod = URL$1.fileURLToPath(new URL$1.URL(url, baseUrl));
				const worker = new threads.Worker(__filename, { workerData: {
					mod,
					name,
					type
				} });
				Object.defineProperty(this, WORKER, { value: worker });
				worker.on("message", (data) => {
					const event = new Event("message");
					event.data = data;
					this.dispatchEvent(event);
				});
				worker.on("error", (error) => {
					error.type = "error";
					this.dispatchEvent(error);
				});
				worker.on("exit", () => {
					this.dispatchEvent(new Event("close"));
				});
			}
			postMessage(data, transferList) {
				this[WORKER].postMessage(data, transferList);
			}
			terminate() {
				this[WORKER].terminate();
			}
		}
		Worker.prototype.onmessage = Worker.prototype.onerror = Worker.prototype.onclose = null;
		return Worker;
	}
	function workerThread() {
		let { mod, name, type } = threads.workerData || {};
		if (!mod) return mainThread();
		const self = global.self = global;
		let q = [];
		function flush() {
			const buffered = q;
			q = null;
			buffered.forEach((event) => {
				self.dispatchEvent(event);
			});
		}
		threads.parentPort.on("message", (data) => {
			const event = new Event("message");
			event.data = data;
			if (q == null) self.dispatchEvent(event);
			else q.push(event);
		});
		threads.parentPort.on("error", (err) => {
			err.type = "Error";
			self.dispatchEvent(err);
		});
		class WorkerGlobalScope extends EventTarget {
			postMessage(data, transferList) {
				threads.parentPort.postMessage(data, transferList);
			}
			close() {
				process.exit();
			}
		}
		let proto = Object.getPrototypeOf(global);
		delete proto.constructor;
		Object.defineProperties(WorkerGlobalScope.prototype, proto);
		proto = Object.setPrototypeOf(global, new WorkerGlobalScope());
		[
			"postMessage",
			"addEventListener",
			"removeEventListener",
			"dispatchEvent"
		].forEach((fn) => {
			proto[fn] = proto[fn].bind(global);
		});
		global.name = name;
		const isDataUrl = /^data:/.test(mod);
		if (type === "module") import(mod).catch((err) => {
			if (isDataUrl && err.message === "Not supported") {
				console.warn("Worker(): Importing data: URLs requires Node 12.10+. Falling back to classic worker.");
				return evaluateDataUrl(mod, name);
			}
			console.error(err);
		}).then(flush);
		else {
			try {
				if (/^data:/.test(mod)) evaluateDataUrl(mod, name);
				else __require(mod);
			} catch (err) {
				console.error(err);
			}
			Promise.resolve().then(flush);
		}
	}
	function evaluateDataUrl(url, name) {
		const { data } = parseDataUrl(url);
		return VM.runInThisContext(data, { filename: "worker.<" + (name || "data:") + ">" });
	}
	function parseDataUrl(url) {
		let [m, type, encoding, data] = url.match(/^data: *([^;,]*)(?: *; *([^,]*))? *,(.*)$/) || [];
		if (!m) throw Error("Invalid Data URL.");
		if (encoding) switch (encoding.toLowerCase()) {
			case "base64":
				data = Buffer.from(data, "base64").toString();
				break;
			default: throw Error("Unknown Data URL encoding \"" + encoding + "\"");
		}
		return {
			type,
			data
		};
	}
})))(), 1);
const getWorker = () => globalThis.Worker || import_node.default;
var WASMAudioDecoderWorker = class extends getWorker() {
	constructor(options, name, Decoder, EmscriptenWASM) {
		if (!WASMAudioDecoderCommon.modules) new WASMAudioDecoderCommon();
		let source = WASMAudioDecoderCommon.modules.get(Decoder);
		if (!source) {
			let type = "text/javascript", isNode, webworkerSourceCode = `'use strict';(${((_Decoder, _WASMAudioDecoderCommon, _EmscriptenWASM) => {
				let decoder, moduleResolve, modulePromise = new Promise((resolve) => {
					moduleResolve = resolve;
				});
				self.onmessage = ({ data: { id, command, data } }) => {
					let messagePromise = modulePromise, messagePayload = { id }, transferList;
					if (command === "init") {
						Object.defineProperties(_Decoder, {
							WASMAudioDecoderCommon: { value: _WASMAudioDecoderCommon },
							EmscriptenWASM: { value: _EmscriptenWASM },
							module: { value: data.module },
							isWebWorker: { value: true }
						});
						decoder = new _Decoder(data.options);
						moduleResolve();
					} else if (command === "free") decoder.free();
					else if (command === "ready") messagePromise = messagePromise.then(() => decoder.ready);
					else if (command === "reset") messagePromise = messagePromise.then(() => decoder.reset());
					else {
						Object.assign(messagePayload, decoder[command](Array.isArray(data) ? data.map((data) => new Uint8Array(data)) : new Uint8Array(data)));
						transferList = messagePayload.channelData ? messagePayload.channelData.map((channel) => channel.buffer) : [];
					}
					messagePromise.then(() => self.postMessage(messagePayload, transferList));
				};
			}).toString()})(${Decoder}, ${WASMAudioDecoderCommon}, ${EmscriptenWASM})`;
			try {
				isNode = typeof process.versions.node !== "undefined";
			} catch {}
			source = isNode ? `data:${type};base64,${Buffer.from(webworkerSourceCode).toString("base64")}` : URL.createObjectURL(new Blob([webworkerSourceCode], { type }));
			WASMAudioDecoderCommon.modules.set(Decoder, source);
		}
		super(source, { name });
		this._id = Number.MIN_SAFE_INTEGER;
		this._enqueuedOperations = /* @__PURE__ */ new Map();
		this.onmessage = ({ data }) => {
			const { id, ...rest } = data;
			this._enqueuedOperations.get(id)(rest);
			this._enqueuedOperations.delete(id);
		};
		new EmscriptenWASM(WASMAudioDecoderCommon).getModule().then((module) => {
			this.postToDecoder("init", {
				module,
				options
			});
		});
	}
	async postToDecoder(command, data) {
		return new Promise((resolve) => {
			this.postMessage({
				command,
				id: this._id,
				data
			});
			this._enqueuedOperations.set(this._id++, resolve);
		});
	}
	get ready() {
		return this.postToDecoder("ready");
	}
	async free() {
		await this.postToDecoder("free").finally(() => {
			this.terminate();
		});
	}
	async reset() {
		await this.postToDecoder("reset");
	}
};
//#endregion
//#region node_modules/@wasm-audio-decoders/common/src/utilities.js
const assignNames = (Class, name) => {
	Object.defineProperty(Class, "name", { value: name });
};
//#endregion
export { WASMAudioDecoderWorker as n, WASMAudioDecoderCommon as r, assignNames as t };
