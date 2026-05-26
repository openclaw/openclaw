import { i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { t as require_src } from "./src-BbQYZdr4.js";
//#region node_modules/agent-base/dist/helpers.js
var require_helpers = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.req = exports.json = exports.toBuffer = void 0;
	const http$1 = __importStar(__require("http"));
	const https = __importStar(__require("https"));
	async function toBuffer(stream) {
		let length = 0;
		const chunks = [];
		for await (const chunk of stream) {
			length += chunk.length;
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, length);
	}
	exports.toBuffer = toBuffer;
	async function json(stream) {
		const str = (await toBuffer(stream)).toString("utf8");
		try {
			return JSON.parse(str);
		} catch (_err) {
			const err = _err;
			err.message += ` (input: ${str})`;
			throw err;
		}
	}
	exports.json = json;
	function req(url, opts = {}) {
		const req = ((typeof url === "string" ? url : url.href).startsWith("https:") ? https : http$1).request(url, opts);
		const promise = new Promise((resolve, reject) => {
			req.once("response", resolve).once("error", reject).end();
		});
		req.then = promise.then.bind(promise);
		return req;
	}
	exports.req = req;
}));
//#endregion
//#region node_modules/agent-base/dist/index.js
var require_dist$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Agent = void 0;
	const net$1 = __importStar(__require("net"));
	const http = __importStar(__require("http"));
	const https_1 = __require("https");
	__exportStar(require_helpers(), exports);
	const INTERNAL = Symbol("AgentBaseInternalState");
	var Agent = class extends http.Agent {
		constructor(opts) {
			super(opts);
			this[INTERNAL] = {};
		}
		/**
		* Determine whether this is an `http` or `https` request.
		*/
		isSecureEndpoint(options) {
			if (options) {
				if (typeof options.secureEndpoint === "boolean") return options.secureEndpoint;
				if (typeof options.protocol === "string") return options.protocol === "https:";
			}
			const { stack } = /* @__PURE__ */ new Error();
			if (typeof stack !== "string") return false;
			return stack.split("\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
		}
		incrementSockets(name) {
			if (this.maxSockets === Infinity && this.maxTotalSockets === Infinity) return null;
			if (!this.sockets[name]) this.sockets[name] = [];
			const fakeSocket = new net$1.Socket({ writable: false });
			this.sockets[name].push(fakeSocket);
			this.totalSocketCount++;
			return fakeSocket;
		}
		decrementSockets(name, socket) {
			if (!this.sockets[name] || socket === null) return;
			const sockets = this.sockets[name];
			const index = sockets.indexOf(socket);
			if (index !== -1) {
				sockets.splice(index, 1);
				this.totalSocketCount--;
				if (sockets.length === 0) delete this.sockets[name];
			}
		}
		getName(options) {
			if (this.isSecureEndpoint(options)) return https_1.Agent.prototype.getName.call(this, options);
			return super.getName(options);
		}
		createSocket(req, options, cb) {
			const connectOpts = {
				...options,
				secureEndpoint: this.isSecureEndpoint(options)
			};
			const name = this.getName(connectOpts);
			const fakeSocket = this.incrementSockets(name);
			Promise.resolve().then(() => this.connect(req, connectOpts)).then((socket) => {
				this.decrementSockets(name, fakeSocket);
				if (socket instanceof http.Agent) try {
					return socket.addRequest(req, connectOpts);
				} catch (err) {
					return cb(err);
				}
				this[INTERNAL].currentSocket = socket;
				super.createSocket(req, options, cb);
			}, (err) => {
				this.decrementSockets(name, fakeSocket);
				cb(err);
			});
		}
		createConnection() {
			const socket = this[INTERNAL].currentSocket;
			this[INTERNAL].currentSocket = void 0;
			if (!socket) throw new Error("No socket was returned in the `connect()` function");
			return socket;
		}
		get defaultPort() {
			return this[INTERNAL].defaultPort ?? (this.protocol === "https:" ? 443 : 80);
		}
		set defaultPort(v) {
			if (this[INTERNAL]) this[INTERNAL].defaultPort = v;
		}
		get protocol() {
			return this[INTERNAL].protocol ?? (this.isSecureEndpoint() ? "https:" : "http:");
		}
		set protocol(v) {
			if (this[INTERNAL]) this[INTERNAL].protocol = v;
		}
	};
	exports.Agent = Agent;
}));
//#endregion
//#region node_modules/https-proxy-agent/dist/parse-proxy-response.js
var require_parse_proxy_response = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.parseProxyResponse = void 0;
	const debug = (0, __importDefault(require_src()).default)("https-proxy-agent:parse-proxy-response");
	function parseProxyResponse(socket) {
		return new Promise((resolve, reject) => {
			let buffersLength = 0;
			const buffers = [];
			function read() {
				const b = socket.read();
				if (b) ondata(b);
				else socket.once("readable", read);
			}
			function cleanup() {
				socket.removeListener("end", onend);
				socket.removeListener("error", onerror);
				socket.removeListener("readable", read);
			}
			function onend() {
				cleanup();
				debug("onend");
				reject(/* @__PURE__ */ new Error("Proxy connection ended before receiving CONNECT response"));
			}
			function onerror(err) {
				cleanup();
				debug("onerror %o", err);
				reject(err);
			}
			function ondata(b) {
				buffers.push(b);
				buffersLength += b.length;
				const buffered = Buffer.concat(buffers, buffersLength);
				const endOfHeaders = buffered.indexOf("\r\n\r\n");
				if (endOfHeaders === -1) {
					debug("have not received end of HTTP headers yet...");
					read();
					return;
				}
				const headerParts = buffered.slice(0, endOfHeaders).toString("ascii").split("\r\n");
				const firstLine = headerParts.shift();
				if (!firstLine) {
					socket.destroy();
					return reject(/* @__PURE__ */ new Error("No header received from proxy CONNECT response"));
				}
				const firstLineParts = firstLine.split(" ");
				const statusCode = +firstLineParts[1];
				const statusText = firstLineParts.slice(2).join(" ");
				const headers = {};
				for (const header of headerParts) {
					if (!header) continue;
					const firstColon = header.indexOf(":");
					if (firstColon === -1) {
						socket.destroy();
						return reject(/* @__PURE__ */ new Error(`Invalid header from proxy CONNECT response: "${header}"`));
					}
					const key = header.slice(0, firstColon).toLowerCase();
					const value = header.slice(firstColon + 1).trimStart();
					const current = headers[key];
					if (typeof current === "string") headers[key] = [current, value];
					else if (Array.isArray(current)) current.push(value);
					else headers[key] = value;
				}
				debug("got proxy server response: %o %o", firstLine, headers);
				cleanup();
				resolve({
					connect: {
						statusCode,
						statusText,
						headers
					},
					buffered
				});
			}
			socket.on("error", onerror);
			socket.on("end", onend);
			read();
		});
	}
	exports.parseProxyResponse = parseProxyResponse;
}));
//#endregion
//#region node_modules/https-proxy-agent/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || function(mod) {
		if (mod && mod.__esModule) return mod;
		var result = {};
		if (mod != null) {
			for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
		}
		__setModuleDefault(result, mod);
		return result;
	};
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HttpsProxyAgent = void 0;
	const net = __importStar(__require("net"));
	const tls = __importStar(__require("tls"));
	const assert_1 = __importDefault(__require("assert"));
	const debug_1 = __importDefault(require_src());
	const agent_base_1 = require_dist$1();
	const url_1 = __require("url");
	const parse_proxy_response_1 = require_parse_proxy_response();
	const debug = (0, debug_1.default)("https-proxy-agent");
	const setServernameFromNonIpHost = (options) => {
		if (options.servername === void 0 && options.host && !net.isIP(options.host)) return {
			...options,
			servername: options.host
		};
		return options;
	};
	/**
	* The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to
	* the specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
	*
	* Outgoing HTTP requests are first tunneled through the proxy server using the
	* `CONNECT` HTTP request method to establish a connection to the proxy server,
	* and then the proxy server connects to the destination target and issues the
	* HTTP request from the proxy server.
	*
	* `https:` requests have their socket connection upgraded to TLS once
	* the connection to the proxy server has been established.
	*/
	var HttpsProxyAgent = class extends agent_base_1.Agent {
		constructor(proxy, opts) {
			super(opts);
			this.options = { path: void 0 };
			this.proxy = typeof proxy === "string" ? new url_1.URL(proxy) : proxy;
			this.proxyHeaders = opts?.headers ?? {};
			debug("Creating new HttpsProxyAgent instance: %o", this.proxy.href);
			const host = (this.proxy.hostname || this.proxy.host).replace(/^\[|\]$/g, "");
			const port = this.proxy.port ? parseInt(this.proxy.port, 10) : this.proxy.protocol === "https:" ? 443 : 80;
			this.connectOpts = {
				ALPNProtocols: ["http/1.1"],
				...opts ? omit(opts, "headers") : null,
				host,
				port
			};
		}
		/**
		* Called when the node-core HTTP client library is creating a
		* new HTTP request.
		*/
		async connect(req, opts) {
			const { proxy } = this;
			if (!opts.host) throw new TypeError("No \"host\" provided");
			let socket;
			if (proxy.protocol === "https:") {
				debug("Creating `tls.Socket`: %o", this.connectOpts);
				socket = tls.connect(setServernameFromNonIpHost(this.connectOpts));
			} else {
				debug("Creating `net.Socket`: %o", this.connectOpts);
				socket = net.connect(this.connectOpts);
			}
			const headers = typeof this.proxyHeaders === "function" ? this.proxyHeaders() : { ...this.proxyHeaders };
			const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
			let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;
			if (proxy.username || proxy.password) {
				const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
				headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
			}
			headers.Host = `${host}:${opts.port}`;
			if (!headers["Proxy-Connection"]) headers["Proxy-Connection"] = this.keepAlive ? "Keep-Alive" : "close";
			for (const name of Object.keys(headers)) payload += `${name}: ${headers[name]}\r\n`;
			const proxyResponsePromise = (0, parse_proxy_response_1.parseProxyResponse)(socket);
			socket.write(`${payload}\r\n`);
			const { connect, buffered } = await proxyResponsePromise;
			req.emit("proxyConnect", connect);
			this.emit("proxyConnect", connect, req);
			if (connect.statusCode === 200) {
				req.once("socket", resume);
				if (opts.secureEndpoint) {
					debug("Upgrading socket connection to TLS");
					return tls.connect({
						...omit(setServernameFromNonIpHost(opts), "host", "path", "port"),
						socket
					});
				}
				return socket;
			}
			socket.destroy();
			const fakeSocket = new net.Socket({ writable: false });
			fakeSocket.readable = true;
			req.once("socket", (s) => {
				debug("Replaying proxy buffer for failed request");
				(0, assert_1.default)(s.listenerCount("data") > 0);
				s.push(buffered);
				s.push(null);
			});
			return fakeSocket;
		}
	};
	HttpsProxyAgent.protocols = ["http", "https"];
	exports.HttpsProxyAgent = HttpsProxyAgent;
	function resume(socket) {
		socket.resume();
	}
	function omit(obj, ...keys) {
		const ret = {};
		let key;
		for (key in obj) if (!keys.includes(key)) ret[key] = obj[key];
		return ret;
	}
}));
//#endregion
export { require_dist as t };
