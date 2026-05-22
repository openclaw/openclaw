import { t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
//#region node_modules/extend/index.js
var require_extend = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var hasOwn = Object.prototype.hasOwnProperty;
	var toStr = Object.prototype.toString;
	var defineProperty = Object.defineProperty;
	var gOPD = Object.getOwnPropertyDescriptor;
	var isArray = function isArray(arr) {
		if (typeof Array.isArray === "function") return Array.isArray(arr);
		return toStr.call(arr) === "[object Array]";
	};
	var isPlainObject = function isPlainObject(obj) {
		if (!obj || toStr.call(obj) !== "[object Object]") return false;
		var hasOwnConstructor = hasOwn.call(obj, "constructor");
		var hasIsPrototypeOf = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, "isPrototypeOf");
		if (obj.constructor && !hasOwnConstructor && !hasIsPrototypeOf) return false;
		var key;
		for (key in obj);
		return typeof key === "undefined" || hasOwn.call(obj, key);
	};
	var setProperty = function setProperty(target, options) {
		if (defineProperty && options.name === "__proto__") defineProperty(target, options.name, {
			enumerable: true,
			configurable: true,
			value: options.newValue,
			writable: true
		});
		else target[options.name] = options.newValue;
	};
	var getProperty = function getProperty(obj, name) {
		if (name === "__proto__") {
			if (!hasOwn.call(obj, name)) return;
			else if (gOPD) return gOPD(obj, name).value;
		}
		return obj[name];
	};
	module.exports = function extend() {
		var options, name, src, copy, copyIsArray, clone;
		var target = arguments[0];
		var i = 1;
		var length = arguments.length;
		var deep = false;
		if (typeof target === "boolean") {
			deep = target;
			target = arguments[1] || {};
			i = 2;
		}
		if (target == null || typeof target !== "object" && typeof target !== "function") target = {};
		for (; i < length; ++i) {
			options = arguments[i];
			if (options != null) for (name in options) {
				src = getProperty(target, name);
				copy = getProperty(options, name);
				if (target !== copy) {
					if (deep && copy && (isPlainObject(copy) || (copyIsArray = isArray(copy)))) {
						if (copyIsArray) {
							copyIsArray = false;
							clone = src && isArray(src) ? src : [];
						} else clone = src && isPlainObject(src) ? src : {};
						setProperty(target, {
							name,
							newValue: extend(deep, clone, copy)
						});
					} else if (typeof copy !== "undefined") setProperty(target, {
						name,
						newValue: copy
					});
				}
			}
		}
		return target;
	};
}));
//#endregion
//#region node_modules/gaxios/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "gaxios",
		"version": "7.1.4",
		"description": "A simple common HTTP client specifically for Google APIs and services.",
		"main": "build/cjs/src/index.js",
		"types": "build/cjs/src/index.d.ts",
		"files": ["build/"],
		"exports": { ".": {
			"import": {
				"types": "./build/esm/src/index.d.ts",
				"default": "./build/esm/src/index.js"
			},
			"require": {
				"types": "./build/cjs/src/index.d.ts",
				"default": "./build/cjs/src/index.js"
			}
		} },
		"scripts": {
			"lint": "gts check --no-inline-config",
			"test": "c8 mocha build/esm/test",
			"presystem-test": "npm run compile",
			"system-test": "mocha build/esm/system-test --timeout 80000",
			"compile": "tsc -b ./tsconfig.json ./tsconfig.cjs.json && node utils/enable-esm.mjs",
			"fix": "gts fix",
			"prepare": "npm run compile",
			"pretest": "npm run compile",
			"webpack": "webpack",
			"prebrowser-test": "npm run compile",
			"browser-test": "node build/browser-test/browser-test-runner.js",
			"docs": "jsdoc -c .jsdoc.js",
			"docs-test": "linkinator docs",
			"predocs-test": "npm run docs",
			"samples-test": "cd samples/ && npm link ../ && npm test && cd ../",
			"prelint": "cd samples; npm link ../; npm install",
			"clean": "gts clean"
		},
		"repository": {
			"type": "git",
			"directory": "packages/gaxios",
			"url": "https://github.com/googleapis/google-cloud-node-core.git"
		},
		"keywords": ["google"],
		"engines": { "node": ">=18" },
		"author": "Google, LLC",
		"license": "Apache-2.0",
		"devDependencies": {
			"@babel/plugin-proposal-private-methods": "^7.18.6",
			"@types/cors": "^2.8.6",
			"@types/express": "^5.0.0",
			"@types/extend": "^3.0.1",
			"@types/mocha": "^10.0.10",
			"@types/multiparty": "4.2.1",
			"@types/mv": "^2.1.0",
			"@types/ncp": "^2.0.8",
			"@types/node": "^22.13.1",
			"@types/sinon": "^17.0.3",
			"@types/tmp": "^0.2.6",
			"assert": "^2.0.0",
			"browserify": "^17.0.0",
			"c8": "^10.1.3",
			"cors": "^2.8.5",
			"express": "^5.0.0",
			"gts": "^6.0.2",
			"is-docker": "^3.0.0",
			"jsdoc": "^4.0.4",
			"jsdoc-fresh": "^5.0.0",
			"jsdoc-region-tag": "^4.0.0",
			"karma": "^6.0.0",
			"karma-chrome-launcher": "^3.0.0",
			"karma-coverage": "^2.0.0",
			"karma-firefox-launcher": "^2.0.0",
			"karma-mocha": "^2.0.0",
			"karma-remap-coverage": "^0.1.5",
			"karma-sourcemap-loader": "^0.4.0",
			"karma-webpack": "^5.0.1",
			"linkinator": "^6.1.2",
			"mocha": "^11.1.0",
			"multiparty": "^4.2.1",
			"mv": "^2.1.1",
			"ncp": "^2.0.0",
			"nock": "^14.0.5",
			"null-loader": "^4.0.1",
			"pack-n-play": "^4.0.0",
			"puppeteer": "^24.0.0",
			"sinon": "^21.0.0",
			"stream-browserify": "^3.0.0",
			"tmp": "0.2.5",
			"ts-loader": "^9.5.2",
			"typescript": "5.8.3",
			"webpack": "^5.97.1",
			"webpack-cli": "^6.0.1"
		},
		"dependencies": {
			"extend": "^3.0.2",
			"https-proxy-agent": "^7.0.1",
			"node-fetch": "^3.3.2"
		},
		"homepage": "https://github.com/googleapis/google-cloud-node-core/tree/main/packages/gaxios"
	};
}));
//#endregion
export { require_extend as n, require_package as t };
