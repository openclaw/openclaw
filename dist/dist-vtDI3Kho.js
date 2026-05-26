import { a as __toCommonJS, i as __require, n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { i as require_axios, n as require_lib$2, r as require_dist$3, t as require_dist$2 } from "./dist-DBYzTIU1.js";
import { t as require_jsonwebtoken } from "./jsonwebtoken-B6pspOPx.js";
import { t as require_src } from "./src-DsW3vwWd.js";
import { createHash } from "node:crypto";
//#region node_modules/@microsoft/teams.apps/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "@microsoft/teams.apps",
		"version": "2.0.11",
		"license": "MIT",
		"main": "./dist/index.js",
		"module": "./dist/index.mjs",
		"types": "./dist/index.d.ts",
		"homepage": "https://github.com/microsoft/teams.ts",
		"bugs": "https://github.com/microsoft/teams.ts/issues",
		"files": ["dist", "README.md"],
		"engines": { "node": ">=20" },
		"repository": {
			"type": "git",
			"url": "https://github.com/microsoft/teams.ts.git",
			"directory": "packages/apps"
		},
		"keywords": [
			"microsoft",
			"teams",
			"msteams",
			"copilot",
			"ai",
			"adaptive-cards",
			"apps",
			"bots"
		],
		"scripts": {
			"clean": "npx rimraf ./dist",
			"lint": "npx eslint",
			"lint:fix": "npx eslint --fix",
			"build": "npx tsc",
			"test": "npx jest",
			"generate": "npx quicktype -s schema -l typescript ./manifest.schema.json -o ./src/manifest.ts --prefer-unions --prefer-types --just-types"
		},
		"dependencies": {
			"@azure/msal-node": "^3.8.1",
			"@microsoft/teams.api": "2.0.11",
			"@microsoft/teams.common": "2.0.11",
			"@microsoft/teams.graph": "2.0.11",
			"axios": "^1.15.2",
			"cors": "^2.8.5",
			"express": "^5.0.0",
			"jsonwebtoken": "^9.0.2",
			"jwks-rsa": "^3.2.0",
			"reflect-metadata": "^0.2.2"
		},
		"devDependencies": {
			"@microsoft/teams.config": "2.0.11",
			"@types/cors": "^2.8.17",
			"@types/express": "^5.0.0",
			"@types/jest": "^29.5.12",
			"@types/node": "^22.0.2",
			"@types/supertest": "^6.0.2",
			"cross-env": "^7.0.3",
			"jest": "^29.7.0",
			"jsonwebtoken": "^9.0.2",
			"quicktype": "^23.0.171",
			"rimraf": "^6.0.1",
			"supertest": "^7.0.0",
			"ts-jest": "^29.2.5",
			"tsup": "^8.4.0",
			"typescript": "^5.4.5"
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/app-events.js
var require_app_events$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/event-handler.js
var require_event_handler = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin.js
var require_plugin$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin-activity-event.js
var require_plugin_activity_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin-activity-sent-event.js
var require_plugin_activity_sent_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin-activity-response-event.js
var require_plugin_activity_response_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin-error-event.js
var require_plugin_error_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/plugin-start-event.js
var require_plugin_start_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/sender.js
var require_sender = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/reflect-metadata/Reflect.js
var require_Reflect = /* @__PURE__ */ __commonJSMin((() => {
	/*! *****************************************************************************
	Copyright (C) Microsoft. All rights reserved.
	Licensed under the Apache License, Version 2.0 (the "License"); you may not use
	this file except in compliance with the License. You may obtain a copy of the
	License at http://www.apache.org/licenses/LICENSE-2.0
	
	THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
	KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
	WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
	MERCHANTABLITY OR NON-INFRINGEMENT.
	
	See the Apache Version 2.0 License for specific language governing permissions
	and limitations under the License.
	***************************************************************************** */
	var Reflect;
	(function(Reflect) {
		(function(factory) {
			var root = typeof globalThis === "object" ? globalThis : typeof global === "object" ? global : typeof self === "object" ? self : typeof this === "object" ? this : sloppyModeThis();
			var exporter = makeExporter(Reflect);
			if (typeof root.Reflect !== "undefined") exporter = makeExporter(root.Reflect, exporter);
			factory(exporter, root);
			if (typeof root.Reflect === "undefined") root.Reflect = Reflect;
			function makeExporter(target, previous) {
				return function(key, value) {
					Object.defineProperty(target, key, {
						configurable: true,
						writable: true,
						value
					});
					if (previous) previous(key, value);
				};
			}
			function functionThis() {
				try {
					return Function("return this;")();
				} catch (_) {}
			}
			function indirectEvalThis() {
				try {
					return (0, eval)("(function() { return this; })()");
				} catch (_) {}
			}
			function sloppyModeThis() {
				return functionThis() || indirectEvalThis();
			}
		})(function(exporter, root) {
			var hasOwn = Object.prototype.hasOwnProperty;
			var supportsSymbol = typeof Symbol === "function";
			var toPrimitiveSymbol = supportsSymbol && typeof Symbol.toPrimitive !== "undefined" ? Symbol.toPrimitive : "@@toPrimitive";
			var iteratorSymbol = supportsSymbol && typeof Symbol.iterator !== "undefined" ? Symbol.iterator : "@@iterator";
			var supportsCreate = typeof Object.create === "function";
			var supportsProto = { __proto__: [] } instanceof Array;
			var downLevel = !supportsCreate && !supportsProto;
			var HashMap = {
				create: supportsCreate ? function() {
					return MakeDictionary(Object.create(null));
				} : supportsProto ? function() {
					return MakeDictionary({ __proto__: null });
				} : function() {
					return MakeDictionary({});
				},
				has: downLevel ? function(map, key) {
					return hasOwn.call(map, key);
				} : function(map, key) {
					return key in map;
				},
				get: downLevel ? function(map, key) {
					return hasOwn.call(map, key) ? map[key] : void 0;
				} : function(map, key) {
					return map[key];
				}
			};
			var functionPrototype = Object.getPrototypeOf(Function);
			var _Map = typeof Map === "function" && typeof Map.prototype.entries === "function" ? Map : CreateMapPolyfill();
			var _Set = typeof Set === "function" && typeof Set.prototype.entries === "function" ? Set : CreateSetPolyfill();
			var _WeakMap = typeof WeakMap === "function" ? WeakMap : CreateWeakMapPolyfill();
			var registrySymbol = supportsSymbol ? Symbol.for("@reflect-metadata:registry") : void 0;
			var metadataRegistry = GetOrCreateMetadataRegistry();
			var metadataProvider = CreateMetadataProvider(metadataRegistry);
			/**
			* Applies a set of decorators to a property of a target object.
			* @param decorators An array of decorators.
			* @param target The target object.
			* @param propertyKey (Optional) The property key to decorate.
			* @param attributes (Optional) The property descriptor for the target key.
			* @remarks Decorators are applied in reverse order.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     Example = Reflect.decorate(decoratorsArray, Example);
			*
			*     // property (on constructor)
			*     Reflect.decorate(decoratorsArray, Example, "staticProperty");
			*
			*     // property (on prototype)
			*     Reflect.decorate(decoratorsArray, Example.prototype, "property");
			*
			*     // method (on constructor)
			*     Object.defineProperty(Example, "staticMethod",
			*         Reflect.decorate(decoratorsArray, Example, "staticMethod",
			*             Object.getOwnPropertyDescriptor(Example, "staticMethod")));
			*
			*     // method (on prototype)
			*     Object.defineProperty(Example.prototype, "method",
			*         Reflect.decorate(decoratorsArray, Example.prototype, "method",
			*             Object.getOwnPropertyDescriptor(Example.prototype, "method")));
			*
			*/
			function decorate(decorators, target, propertyKey, attributes) {
				if (!IsUndefined(propertyKey)) {
					if (!IsArray(decorators)) throw new TypeError();
					if (!IsObject(target)) throw new TypeError();
					if (!IsObject(attributes) && !IsUndefined(attributes) && !IsNull(attributes)) throw new TypeError();
					if (IsNull(attributes)) attributes = void 0;
					propertyKey = ToPropertyKey(propertyKey);
					return DecorateProperty(decorators, target, propertyKey, attributes);
				} else {
					if (!IsArray(decorators)) throw new TypeError();
					if (!IsConstructor(target)) throw new TypeError();
					return DecorateConstructor(decorators, target);
				}
			}
			exporter("decorate", decorate);
			/**
			* A default metadata decorator factory that can be used on a class, class member, or parameter.
			* @param metadataKey The key for the metadata entry.
			* @param metadataValue The value for the metadata entry.
			* @returns A decorator function.
			* @remarks
			* If `metadataKey` is already defined for the target and target key, the
			* metadataValue for that key will be overwritten.
			* @example
			*
			*     // constructor
			*     @Reflect.metadata(key, value)
			*     class Example {
			*     }
			*
			*     // property (on constructor, TypeScript only)
			*     class Example {
			*         @Reflect.metadata(key, value)
			*         static staticProperty;
			*     }
			*
			*     // property (on prototype, TypeScript only)
			*     class Example {
			*         @Reflect.metadata(key, value)
			*         property;
			*     }
			*
			*     // method (on constructor)
			*     class Example {
			*         @Reflect.metadata(key, value)
			*         static staticMethod() { }
			*     }
			*
			*     // method (on prototype)
			*     class Example {
			*         @Reflect.metadata(key, value)
			*         method() { }
			*     }
			*
			*/
			function metadata(metadataKey, metadataValue) {
				function decorator(target, propertyKey) {
					if (!IsObject(target)) throw new TypeError();
					if (!IsUndefined(propertyKey) && !IsPropertyKey(propertyKey)) throw new TypeError();
					OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, propertyKey);
				}
				return decorator;
			}
			exporter("metadata", metadata);
			/**
			* Define a unique metadata entry on the target.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param metadataValue A value that contains attached metadata.
			* @param target The target object on which to define metadata.
			* @param propertyKey (Optional) The property key for the target.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     Reflect.defineMetadata("custom:annotation", options, Example);
			*
			*     // property (on constructor)
			*     Reflect.defineMetadata("custom:annotation", options, Example, "staticProperty");
			*
			*     // property (on prototype)
			*     Reflect.defineMetadata("custom:annotation", options, Example.prototype, "property");
			*
			*     // method (on constructor)
			*     Reflect.defineMetadata("custom:annotation", options, Example, "staticMethod");
			*
			*     // method (on prototype)
			*     Reflect.defineMetadata("custom:annotation", options, Example.prototype, "method");
			*
			*     // decorator factory as metadata-producing annotation.
			*     function MyAnnotation(options): Decorator {
			*         return (target, key?) => Reflect.defineMetadata("custom:annotation", options, target, key);
			*     }
			*
			*/
			function defineMetadata(metadataKey, metadataValue, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryDefineOwnMetadata(metadataKey, metadataValue, target, propertyKey);
			}
			exporter("defineMetadata", defineMetadata);
			/**
			* Gets a value indicating whether the target object or its prototype chain has the provided metadata key defined.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns `true` if the metadata key was defined on the target object or its prototype chain; otherwise, `false`.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.hasMetadata("custom:annotation", Example);
			*
			*     // property (on constructor)
			*     result = Reflect.hasMetadata("custom:annotation", Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.hasMetadata("custom:annotation", Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.hasMetadata("custom:annotation", Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.hasMetadata("custom:annotation", Example.prototype, "method");
			*
			*/
			function hasMetadata(metadataKey, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryHasMetadata(metadataKey, target, propertyKey);
			}
			exporter("hasMetadata", hasMetadata);
			/**
			* Gets a value indicating whether the target object has the provided metadata key defined.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns `true` if the metadata key was defined on the target object; otherwise, `false`.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.hasOwnMetadata("custom:annotation", Example);
			*
			*     // property (on constructor)
			*     result = Reflect.hasOwnMetadata("custom:annotation", Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.hasOwnMetadata("custom:annotation", Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.hasOwnMetadata("custom:annotation", Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.hasOwnMetadata("custom:annotation", Example.prototype, "method");
			*
			*/
			function hasOwnMetadata(metadataKey, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryHasOwnMetadata(metadataKey, target, propertyKey);
			}
			exporter("hasOwnMetadata", hasOwnMetadata);
			/**
			* Gets the metadata value for the provided metadata key on the target object or its prototype chain.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns The metadata value for the metadata key if found; otherwise, `undefined`.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.getMetadata("custom:annotation", Example);
			*
			*     // property (on constructor)
			*     result = Reflect.getMetadata("custom:annotation", Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.getMetadata("custom:annotation", Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.getMetadata("custom:annotation", Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.getMetadata("custom:annotation", Example.prototype, "method");
			*
			*/
			function getMetadata(metadataKey, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryGetMetadata(metadataKey, target, propertyKey);
			}
			exporter("getMetadata", getMetadata);
			/**
			* Gets the metadata value for the provided metadata key on the target object.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns The metadata value for the metadata key if found; otherwise, `undefined`.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.getOwnMetadata("custom:annotation", Example);
			*
			*     // property (on constructor)
			*     result = Reflect.getOwnMetadata("custom:annotation", Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.getOwnMetadata("custom:annotation", Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.getOwnMetadata("custom:annotation", Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.getOwnMetadata("custom:annotation", Example.prototype, "method");
			*
			*/
			function getOwnMetadata(metadataKey, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryGetOwnMetadata(metadataKey, target, propertyKey);
			}
			exporter("getOwnMetadata", getOwnMetadata);
			/**
			* Gets the metadata keys defined on the target object or its prototype chain.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns An array of unique metadata keys.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.getMetadataKeys(Example);
			*
			*     // property (on constructor)
			*     result = Reflect.getMetadataKeys(Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.getMetadataKeys(Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.getMetadataKeys(Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.getMetadataKeys(Example.prototype, "method");
			*
			*/
			function getMetadataKeys(target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryMetadataKeys(target, propertyKey);
			}
			exporter("getMetadataKeys", getMetadataKeys);
			/**
			* Gets the unique metadata keys defined on the target object.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns An array of unique metadata keys.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.getOwnMetadataKeys(Example);
			*
			*     // property (on constructor)
			*     result = Reflect.getOwnMetadataKeys(Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.getOwnMetadataKeys(Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.getOwnMetadataKeys(Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.getOwnMetadataKeys(Example.prototype, "method");
			*
			*/
			function getOwnMetadataKeys(target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				return OrdinaryOwnMetadataKeys(target, propertyKey);
			}
			exporter("getOwnMetadataKeys", getOwnMetadataKeys);
			/**
			* Deletes the metadata entry from the target object with the provided key.
			* @param metadataKey A key used to store and retrieve metadata.
			* @param target The target object on which the metadata is defined.
			* @param propertyKey (Optional) The property key for the target.
			* @returns `true` if the metadata entry was found and deleted; otherwise, false.
			* @example
			*
			*     class Example {
			*         // property declarations are not part of ES6, though they are valid in TypeScript:
			*         // static staticProperty;
			*         // property;
			*
			*         constructor(p) { }
			*         static staticMethod(p) { }
			*         method(p) { }
			*     }
			*
			*     // constructor
			*     result = Reflect.deleteMetadata("custom:annotation", Example);
			*
			*     // property (on constructor)
			*     result = Reflect.deleteMetadata("custom:annotation", Example, "staticProperty");
			*
			*     // property (on prototype)
			*     result = Reflect.deleteMetadata("custom:annotation", Example.prototype, "property");
			*
			*     // method (on constructor)
			*     result = Reflect.deleteMetadata("custom:annotation", Example, "staticMethod");
			*
			*     // method (on prototype)
			*     result = Reflect.deleteMetadata("custom:annotation", Example.prototype, "method");
			*
			*/
			function deleteMetadata(metadataKey, target, propertyKey) {
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				if (!IsObject(target)) throw new TypeError();
				if (!IsUndefined(propertyKey)) propertyKey = ToPropertyKey(propertyKey);
				var provider = GetMetadataProvider(target, propertyKey, false);
				if (IsUndefined(provider)) return false;
				return provider.OrdinaryDeleteMetadata(metadataKey, target, propertyKey);
			}
			exporter("deleteMetadata", deleteMetadata);
			function DecorateConstructor(decorators, target) {
				for (var i = decorators.length - 1; i >= 0; --i) {
					var decorator = decorators[i];
					var decorated = decorator(target);
					if (!IsUndefined(decorated) && !IsNull(decorated)) {
						if (!IsConstructor(decorated)) throw new TypeError();
						target = decorated;
					}
				}
				return target;
			}
			function DecorateProperty(decorators, target, propertyKey, descriptor) {
				for (var i = decorators.length - 1; i >= 0; --i) {
					var decorator = decorators[i];
					var decorated = decorator(target, propertyKey, descriptor);
					if (!IsUndefined(decorated) && !IsNull(decorated)) {
						if (!IsObject(decorated)) throw new TypeError();
						descriptor = decorated;
					}
				}
				return descriptor;
			}
			function OrdinaryHasMetadata(MetadataKey, O, P) {
				if (OrdinaryHasOwnMetadata(MetadataKey, O, P)) return true;
				var parent = OrdinaryGetPrototypeOf(O);
				if (!IsNull(parent)) return OrdinaryHasMetadata(MetadataKey, parent, P);
				return false;
			}
			function OrdinaryHasOwnMetadata(MetadataKey, O, P) {
				var provider = GetMetadataProvider(O, P, false);
				if (IsUndefined(provider)) return false;
				return ToBoolean(provider.OrdinaryHasOwnMetadata(MetadataKey, O, P));
			}
			function OrdinaryGetMetadata(MetadataKey, O, P) {
				if (OrdinaryHasOwnMetadata(MetadataKey, O, P)) return OrdinaryGetOwnMetadata(MetadataKey, O, P);
				var parent = OrdinaryGetPrototypeOf(O);
				if (!IsNull(parent)) return OrdinaryGetMetadata(MetadataKey, parent, P);
			}
			function OrdinaryGetOwnMetadata(MetadataKey, O, P) {
				var provider = GetMetadataProvider(O, P, false);
				if (IsUndefined(provider)) return;
				return provider.OrdinaryGetOwnMetadata(MetadataKey, O, P);
			}
			function OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P) {
				GetMetadataProvider(O, P, true).OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P);
			}
			function OrdinaryMetadataKeys(O, P) {
				var ownKeys = OrdinaryOwnMetadataKeys(O, P);
				var parent = OrdinaryGetPrototypeOf(O);
				if (parent === null) return ownKeys;
				var parentKeys = OrdinaryMetadataKeys(parent, P);
				if (parentKeys.length <= 0) return ownKeys;
				if (ownKeys.length <= 0) return parentKeys;
				var set = new _Set();
				var keys = [];
				for (var _i = 0, ownKeys_1 = ownKeys; _i < ownKeys_1.length; _i++) {
					var key = ownKeys_1[_i];
					var hasKey = set.has(key);
					if (!hasKey) {
						set.add(key);
						keys.push(key);
					}
				}
				for (var _a = 0, parentKeys_1 = parentKeys; _a < parentKeys_1.length; _a++) {
					var key = parentKeys_1[_a];
					var hasKey = set.has(key);
					if (!hasKey) {
						set.add(key);
						keys.push(key);
					}
				}
				return keys;
			}
			function OrdinaryOwnMetadataKeys(O, P) {
				var provider = GetMetadataProvider(O, P, false);
				if (!provider) return [];
				return provider.OrdinaryOwnMetadataKeys(O, P);
			}
			function Type(x) {
				if (x === null) return 1;
				switch (typeof x) {
					case "undefined": return 0;
					case "boolean": return 2;
					case "string": return 3;
					case "symbol": return 4;
					case "number": return 5;
					case "object": return x === null ? 1 : 6;
					default: return 6;
				}
			}
			function IsUndefined(x) {
				return x === void 0;
			}
			function IsNull(x) {
				return x === null;
			}
			function IsSymbol(x) {
				return typeof x === "symbol";
			}
			function IsObject(x) {
				return typeof x === "object" ? x !== null : typeof x === "function";
			}
			function ToPrimitive(input, PreferredType) {
				switch (Type(input)) {
					case 0: return input;
					case 1: return input;
					case 2: return input;
					case 3: return input;
					case 4: return input;
					case 5: return input;
				}
				var hint = PreferredType === 3 ? "string" : PreferredType === 5 ? "number" : "default";
				var exoticToPrim = GetMethod(input, toPrimitiveSymbol);
				if (exoticToPrim !== void 0) {
					var result = exoticToPrim.call(input, hint);
					if (IsObject(result)) throw new TypeError();
					return result;
				}
				return OrdinaryToPrimitive(input, hint === "default" ? "number" : hint);
			}
			function OrdinaryToPrimitive(O, hint) {
				if (hint === "string") {
					var toString_1 = O.toString;
					if (IsCallable(toString_1)) {
						var result = toString_1.call(O);
						if (!IsObject(result)) return result;
					}
					var valueOf = O.valueOf;
					if (IsCallable(valueOf)) {
						var result = valueOf.call(O);
						if (!IsObject(result)) return result;
					}
				} else {
					var valueOf = O.valueOf;
					if (IsCallable(valueOf)) {
						var result = valueOf.call(O);
						if (!IsObject(result)) return result;
					}
					var toString_2 = O.toString;
					if (IsCallable(toString_2)) {
						var result = toString_2.call(O);
						if (!IsObject(result)) return result;
					}
				}
				throw new TypeError();
			}
			function ToBoolean(argument) {
				return !!argument;
			}
			function ToString(argument) {
				return "" + argument;
			}
			function ToPropertyKey(argument) {
				var key = ToPrimitive(argument, 3);
				if (IsSymbol(key)) return key;
				return ToString(key);
			}
			function IsArray(argument) {
				return Array.isArray ? Array.isArray(argument) : argument instanceof Object ? argument instanceof Array : Object.prototype.toString.call(argument) === "[object Array]";
			}
			function IsCallable(argument) {
				return typeof argument === "function";
			}
			function IsConstructor(argument) {
				return typeof argument === "function";
			}
			function IsPropertyKey(argument) {
				switch (Type(argument)) {
					case 3: return true;
					case 4: return true;
					default: return false;
				}
			}
			function SameValueZero(x, y) {
				return x === y || x !== x && y !== y;
			}
			function GetMethod(V, P) {
				var func = V[P];
				if (func === void 0 || func === null) return void 0;
				if (!IsCallable(func)) throw new TypeError();
				return func;
			}
			function GetIterator(obj) {
				var method = GetMethod(obj, iteratorSymbol);
				if (!IsCallable(method)) throw new TypeError();
				var iterator = method.call(obj);
				if (!IsObject(iterator)) throw new TypeError();
				return iterator;
			}
			function IteratorValue(iterResult) {
				return iterResult.value;
			}
			function IteratorStep(iterator) {
				var result = iterator.next();
				return result.done ? false : result;
			}
			function IteratorClose(iterator) {
				var f = iterator["return"];
				if (f) f.call(iterator);
			}
			function OrdinaryGetPrototypeOf(O) {
				var proto = Object.getPrototypeOf(O);
				if (typeof O !== "function" || O === functionPrototype) return proto;
				if (proto !== functionPrototype) return proto;
				var prototype = O.prototype;
				var prototypeProto = prototype && Object.getPrototypeOf(prototype);
				if (prototypeProto == null || prototypeProto === Object.prototype) return proto;
				var constructor = prototypeProto.constructor;
				if (typeof constructor !== "function") return proto;
				if (constructor === O) return proto;
				return constructor;
			}
			/**
			* Creates a registry used to allow multiple `reflect-metadata` providers.
			*/
			function CreateMetadataRegistry() {
				var fallback;
				if (!IsUndefined(registrySymbol) && typeof root.Reflect !== "undefined" && !(registrySymbol in root.Reflect) && typeof root.Reflect.defineMetadata === "function") fallback = CreateFallbackProvider(root.Reflect);
				var first;
				var second;
				var rest;
				var targetProviderMap = new _WeakMap();
				var registry = {
					registerProvider,
					getProvider,
					setProvider
				};
				return registry;
				function registerProvider(provider) {
					if (!Object.isExtensible(registry)) throw new Error("Cannot add provider to a frozen registry.");
					switch (true) {
						case fallback === provider: break;
						case IsUndefined(first):
							first = provider;
							break;
						case first === provider: break;
						case IsUndefined(second):
							second = provider;
							break;
						case second === provider: break;
						default:
							if (rest === void 0) rest = new _Set();
							rest.add(provider);
							break;
					}
				}
				function getProviderNoCache(O, P) {
					if (!IsUndefined(first)) {
						if (first.isProviderFor(O, P)) return first;
						if (!IsUndefined(second)) {
							if (second.isProviderFor(O, P)) return first;
							if (!IsUndefined(rest)) {
								var iterator = GetIterator(rest);
								while (true) {
									var next = IteratorStep(iterator);
									if (!next) return;
									var provider = IteratorValue(next);
									if (provider.isProviderFor(O, P)) {
										IteratorClose(iterator);
										return provider;
									}
								}
							}
						}
					}
					if (!IsUndefined(fallback) && fallback.isProviderFor(O, P)) return fallback;
				}
				function getProvider(O, P) {
					var providerMap = targetProviderMap.get(O);
					var provider;
					if (!IsUndefined(providerMap)) provider = providerMap.get(P);
					if (!IsUndefined(provider)) return provider;
					provider = getProviderNoCache(O, P);
					if (!IsUndefined(provider)) {
						if (IsUndefined(providerMap)) {
							providerMap = new _Map();
							targetProviderMap.set(O, providerMap);
						}
						providerMap.set(P, provider);
					}
					return provider;
				}
				function hasProvider(provider) {
					if (IsUndefined(provider)) throw new TypeError();
					return first === provider || second === provider || !IsUndefined(rest) && rest.has(provider);
				}
				function setProvider(O, P, provider) {
					if (!hasProvider(provider)) throw new Error("Metadata provider not registered.");
					var existingProvider = getProvider(O, P);
					if (existingProvider !== provider) {
						if (!IsUndefined(existingProvider)) return false;
						var providerMap = targetProviderMap.get(O);
						if (IsUndefined(providerMap)) {
							providerMap = new _Map();
							targetProviderMap.set(O, providerMap);
						}
						providerMap.set(P, provider);
					}
					return true;
				}
			}
			/**
			* Gets or creates the shared registry of metadata providers.
			*/
			function GetOrCreateMetadataRegistry() {
				var metadataRegistry;
				if (!IsUndefined(registrySymbol) && IsObject(root.Reflect) && Object.isExtensible(root.Reflect)) metadataRegistry = root.Reflect[registrySymbol];
				if (IsUndefined(metadataRegistry)) metadataRegistry = CreateMetadataRegistry();
				if (!IsUndefined(registrySymbol) && IsObject(root.Reflect) && Object.isExtensible(root.Reflect)) Object.defineProperty(root.Reflect, registrySymbol, {
					enumerable: false,
					configurable: false,
					writable: false,
					value: metadataRegistry
				});
				return metadataRegistry;
			}
			function CreateMetadataProvider(registry) {
				var metadata = new _WeakMap();
				var provider = {
					isProviderFor: function(O, P) {
						var targetMetadata = metadata.get(O);
						if (IsUndefined(targetMetadata)) return false;
						return targetMetadata.has(P);
					},
					OrdinaryDefineOwnMetadata,
					OrdinaryHasOwnMetadata,
					OrdinaryGetOwnMetadata,
					OrdinaryOwnMetadataKeys,
					OrdinaryDeleteMetadata
				};
				metadataRegistry.registerProvider(provider);
				return provider;
				function GetOrCreateMetadataMap(O, P, Create) {
					var targetMetadata = metadata.get(O);
					var createdTargetMetadata = false;
					if (IsUndefined(targetMetadata)) {
						if (!Create) return void 0;
						targetMetadata = new _Map();
						metadata.set(O, targetMetadata);
						createdTargetMetadata = true;
					}
					var metadataMap = targetMetadata.get(P);
					if (IsUndefined(metadataMap)) {
						if (!Create) return void 0;
						metadataMap = new _Map();
						targetMetadata.set(P, metadataMap);
						if (!registry.setProvider(O, P, provider)) {
							targetMetadata.delete(P);
							if (createdTargetMetadata) metadata.delete(O);
							throw new Error("Wrong provider for target.");
						}
					}
					return metadataMap;
				}
				function OrdinaryHasOwnMetadata(MetadataKey, O, P) {
					var metadataMap = GetOrCreateMetadataMap(O, P, false);
					if (IsUndefined(metadataMap)) return false;
					return ToBoolean(metadataMap.has(MetadataKey));
				}
				function OrdinaryGetOwnMetadata(MetadataKey, O, P) {
					var metadataMap = GetOrCreateMetadataMap(O, P, false);
					if (IsUndefined(metadataMap)) return void 0;
					return metadataMap.get(MetadataKey);
				}
				function OrdinaryDefineOwnMetadata(MetadataKey, MetadataValue, O, P) {
					GetOrCreateMetadataMap(O, P, true).set(MetadataKey, MetadataValue);
				}
				function OrdinaryOwnMetadataKeys(O, P) {
					var keys = [];
					var metadataMap = GetOrCreateMetadataMap(O, P, false);
					if (IsUndefined(metadataMap)) return keys;
					var iterator = GetIterator(metadataMap.keys());
					var k = 0;
					while (true) {
						var next = IteratorStep(iterator);
						if (!next) {
							keys.length = k;
							return keys;
						}
						var nextValue = IteratorValue(next);
						try {
							keys[k] = nextValue;
						} catch (e) {
							try {
								IteratorClose(iterator);
							} finally {
								throw e;
							}
						}
						k++;
					}
				}
				function OrdinaryDeleteMetadata(MetadataKey, O, P) {
					var metadataMap = GetOrCreateMetadataMap(O, P, false);
					if (IsUndefined(metadataMap)) return false;
					if (!metadataMap.delete(MetadataKey)) return false;
					if (metadataMap.size === 0) {
						var targetMetadata = metadata.get(O);
						if (!IsUndefined(targetMetadata)) {
							targetMetadata.delete(P);
							if (targetMetadata.size === 0) metadata.delete(targetMetadata);
						}
					}
					return true;
				}
			}
			function CreateFallbackProvider(reflect) {
				var defineMetadata = reflect.defineMetadata, hasOwnMetadata = reflect.hasOwnMetadata, getOwnMetadata = reflect.getOwnMetadata, getOwnMetadataKeys = reflect.getOwnMetadataKeys, deleteMetadata = reflect.deleteMetadata;
				var metadataOwner = new _WeakMap();
				return {
					isProviderFor: function(O, P) {
						var metadataPropertySet = metadataOwner.get(O);
						if (!IsUndefined(metadataPropertySet) && metadataPropertySet.has(P)) return true;
						if (getOwnMetadataKeys(O, P).length) {
							if (IsUndefined(metadataPropertySet)) {
								metadataPropertySet = new _Set();
								metadataOwner.set(O, metadataPropertySet);
							}
							metadataPropertySet.add(P);
							return true;
						}
						return false;
					},
					OrdinaryDefineOwnMetadata: defineMetadata,
					OrdinaryHasOwnMetadata: hasOwnMetadata,
					OrdinaryGetOwnMetadata: getOwnMetadata,
					OrdinaryOwnMetadataKeys: getOwnMetadataKeys,
					OrdinaryDeleteMetadata: deleteMetadata
				};
			}
			/**
			* Gets the metadata provider for an object. If the object has no metadata provider and this is for a create operation,
			* then this module's metadata provider is assigned to the object.
			*/
			function GetMetadataProvider(O, P, Create) {
				var registeredProvider = metadataRegistry.getProvider(O, P);
				if (!IsUndefined(registeredProvider)) return registeredProvider;
				if (Create) {
					if (metadataRegistry.setProvider(O, P, metadataProvider)) return metadataProvider;
					throw new Error("Illegal state.");
				}
			}
			function CreateMapPolyfill() {
				var cacheSentinel = {};
				var arraySentinel = [];
				var MapIterator = function() {
					function MapIterator(keys, values, selector) {
						this._index = 0;
						this._keys = keys;
						this._values = values;
						this._selector = selector;
					}
					MapIterator.prototype["@@iterator"] = function() {
						return this;
					};
					MapIterator.prototype[iteratorSymbol] = function() {
						return this;
					};
					MapIterator.prototype.next = function() {
						var index = this._index;
						if (index >= 0 && index < this._keys.length) {
							var result = this._selector(this._keys[index], this._values[index]);
							if (index + 1 >= this._keys.length) {
								this._index = -1;
								this._keys = arraySentinel;
								this._values = arraySentinel;
							} else this._index++;
							return {
								value: result,
								done: false
							};
						}
						return {
							value: void 0,
							done: true
						};
					};
					MapIterator.prototype.throw = function(error) {
						if (this._index >= 0) {
							this._index = -1;
							this._keys = arraySentinel;
							this._values = arraySentinel;
						}
						throw error;
					};
					MapIterator.prototype.return = function(value) {
						if (this._index >= 0) {
							this._index = -1;
							this._keys = arraySentinel;
							this._values = arraySentinel;
						}
						return {
							value,
							done: true
						};
					};
					return MapIterator;
				}();
				return function() {
					function Map() {
						this._keys = [];
						this._values = [];
						this._cacheKey = cacheSentinel;
						this._cacheIndex = -2;
					}
					Object.defineProperty(Map.prototype, "size", {
						get: function() {
							return this._keys.length;
						},
						enumerable: true,
						configurable: true
					});
					Map.prototype.has = function(key) {
						return this._find(key, false) >= 0;
					};
					Map.prototype.get = function(key) {
						var index = this._find(key, false);
						return index >= 0 ? this._values[index] : void 0;
					};
					Map.prototype.set = function(key, value) {
						var index = this._find(key, true);
						this._values[index] = value;
						return this;
					};
					Map.prototype.delete = function(key) {
						var index = this._find(key, false);
						if (index >= 0) {
							var size = this._keys.length;
							for (var i = index + 1; i < size; i++) {
								this._keys[i - 1] = this._keys[i];
								this._values[i - 1] = this._values[i];
							}
							this._keys.length--;
							this._values.length--;
							if (SameValueZero(key, this._cacheKey)) {
								this._cacheKey = cacheSentinel;
								this._cacheIndex = -2;
							}
							return true;
						}
						return false;
					};
					Map.prototype.clear = function() {
						this._keys.length = 0;
						this._values.length = 0;
						this._cacheKey = cacheSentinel;
						this._cacheIndex = -2;
					};
					Map.prototype.keys = function() {
						return new MapIterator(this._keys, this._values, getKey);
					};
					Map.prototype.values = function() {
						return new MapIterator(this._keys, this._values, getValue);
					};
					Map.prototype.entries = function() {
						return new MapIterator(this._keys, this._values, getEntry);
					};
					Map.prototype["@@iterator"] = function() {
						return this.entries();
					};
					Map.prototype[iteratorSymbol] = function() {
						return this.entries();
					};
					Map.prototype._find = function(key, insert) {
						if (!SameValueZero(this._cacheKey, key)) {
							this._cacheIndex = -1;
							for (var i = 0; i < this._keys.length; i++) if (SameValueZero(this._keys[i], key)) {
								this._cacheIndex = i;
								break;
							}
						}
						if (this._cacheIndex < 0 && insert) {
							this._cacheIndex = this._keys.length;
							this._keys.push(key);
							this._values.push(void 0);
						}
						return this._cacheIndex;
					};
					return Map;
				}();
				function getKey(key, _) {
					return key;
				}
				function getValue(_, value) {
					return value;
				}
				function getEntry(key, value) {
					return [key, value];
				}
			}
			function CreateSetPolyfill() {
				return function() {
					function Set() {
						this._map = new _Map();
					}
					Object.defineProperty(Set.prototype, "size", {
						get: function() {
							return this._map.size;
						},
						enumerable: true,
						configurable: true
					});
					Set.prototype.has = function(value) {
						return this._map.has(value);
					};
					Set.prototype.add = function(value) {
						return this._map.set(value, value), this;
					};
					Set.prototype.delete = function(value) {
						return this._map.delete(value);
					};
					Set.prototype.clear = function() {
						this._map.clear();
					};
					Set.prototype.keys = function() {
						return this._map.keys();
					};
					Set.prototype.values = function() {
						return this._map.keys();
					};
					Set.prototype.entries = function() {
						return this._map.entries();
					};
					Set.prototype["@@iterator"] = function() {
						return this.keys();
					};
					Set.prototype[iteratorSymbol] = function() {
						return this.keys();
					};
					return Set;
				}();
			}
			function CreateWeakMapPolyfill() {
				var UUID_SIZE = 16;
				var keys = HashMap.create();
				var rootKey = CreateUniqueKey();
				return function() {
					function WeakMap() {
						this._key = CreateUniqueKey();
					}
					WeakMap.prototype.has = function(target) {
						var table = GetOrCreateWeakMapTable(target, false);
						return table !== void 0 ? HashMap.has(table, this._key) : false;
					};
					WeakMap.prototype.get = function(target) {
						var table = GetOrCreateWeakMapTable(target, false);
						return table !== void 0 ? HashMap.get(table, this._key) : void 0;
					};
					WeakMap.prototype.set = function(target, value) {
						var table = GetOrCreateWeakMapTable(target, true);
						table[this._key] = value;
						return this;
					};
					WeakMap.prototype.delete = function(target) {
						var table = GetOrCreateWeakMapTable(target, false);
						return table !== void 0 ? delete table[this._key] : false;
					};
					WeakMap.prototype.clear = function() {
						this._key = CreateUniqueKey();
					};
					return WeakMap;
				}();
				function CreateUniqueKey() {
					var key;
					do
						key = "@@WeakMap@@" + CreateUUID();
					while (HashMap.has(keys, key));
					keys[key] = true;
					return key;
				}
				function GetOrCreateWeakMapTable(target, create) {
					if (!hasOwn.call(target, rootKey)) {
						if (!create) return void 0;
						Object.defineProperty(target, rootKey, { value: HashMap.create() });
					}
					return target[rootKey];
				}
				function FillRandomBytes(buffer, size) {
					for (var i = 0; i < size; ++i) buffer[i] = Math.random() * 255 | 0;
					return buffer;
				}
				function GenRandomBytes(size) {
					if (typeof Uint8Array === "function") {
						var array = new Uint8Array(size);
						if (typeof crypto !== "undefined") crypto.getRandomValues(array);
						else if (typeof msCrypto !== "undefined") msCrypto.getRandomValues(array);
						else FillRandomBytes(array, size);
						return array;
					}
					return FillRandomBytes(new Array(size), size);
				}
				function CreateUUID() {
					var data = GenRandomBytes(UUID_SIZE);
					data[6] = data[6] & 79 | 64;
					data[8] = data[8] & 191 | 128;
					var result = "";
					for (var offset = 0; offset < UUID_SIZE; ++offset) {
						var byte = data[offset];
						if (offset === 4 || offset === 6 || offset === 8) result += "-";
						if (byte < 16) result += "0";
						result += byte.toString(16).toLowerCase();
					}
					return result;
				}
			}
			function MakeDictionary(obj) {
				obj.__ = void 0;
				delete obj.__;
				return obj;
			}
		});
	})(Reflect || (Reflect = {}));
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/decorators/plugin.js
var require_plugin$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PLUGIN_METADATA_KEY = void 0;
	exports.Plugin = Plugin;
	require_Reflect();
	exports.PLUGIN_METADATA_KEY = "teams:plugin";
	/**
	* turn any class into a plugin via
	* `@Plugin({ ... })`
	*/
	function Plugin(metadata = {}) {
		return (Base) => {
			const name = metadata.name || Base.name;
			const version = metadata.version || "0.0.0";
			Reflect.defineMetadata(exports.PLUGIN_METADATA_KEY, {
				name,
				version,
				description: metadata.description
			}, Base);
			return Base;
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/decorators/dependency.js
var require_dependency = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PLUGIN_DEPENDENCIES_METADATA_KEY = void 0;
	exports.Dependency = Dependency;
	exports.Logger = Logger;
	exports.Storage = Storage;
	exports.HttpServer = HttpServer;
	require_Reflect();
	const plugin_1 = require_plugin$2();
	exports.PLUGIN_DEPENDENCIES_METADATA_KEY = "teams:plugin:dependencies";
	/**
	* add plugin dependencies via
	* `@Dependency()`
	*/
	function Dependency(options = {}) {
		const name = options.name;
		const optional = options.optional || false;
		return (target, propertyKey) => {
			if (typeof propertyKey === "string") {
				const TargetType = target.constructor;
				const FieldType = Reflect.getMetadata("design:type", target, propertyKey);
				let fieldTypeKey = name || FieldType.name;
				if (Reflect.hasMetadata(plugin_1.PLUGIN_METADATA_KEY, FieldType)) fieldTypeKey = Reflect.getMetadata(plugin_1.PLUGIN_METADATA_KEY, FieldType).name;
				const targetFieldsMetadata = Reflect.getOwnMetadata(exports.PLUGIN_DEPENDENCIES_METADATA_KEY, TargetType) || [];
				targetFieldsMetadata.push({
					key: propertyKey,
					type: fieldTypeKey,
					optional
				});
				Reflect.defineMetadata(exports.PLUGIN_DEPENDENCIES_METADATA_KEY, targetFieldsMetadata, TargetType);
			}
		};
	}
	/**
	* inject the `App` `ILogger` instance
	*/
	function Logger() {
		return Dependency({ name: "ILogger" });
	}
	/**
	* inject the `App` `IStorage` instance
	*/
	function Storage() {
		return Dependency({ name: "IStorage" });
	}
	/**
	* inject the `App` `IHttpServer` instance
	*/
	function HttpServer() {
		return Dependency({ name: "IHttpServer" });
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/decorators/event.js
var require_event$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PLUGIN_EVENTS_METADATA_KEY = void 0;
	exports.Event = Event;
	require_Reflect();
	exports.PLUGIN_EVENTS_METADATA_KEY = "teams:plugin:events";
	/**
	* add an event emitter to your plugin
	* via `@Event(...)`
	*/
	function Event(name) {
		return (target, propertyKey) => {
			if (typeof propertyKey === "string") {
				const TargetType = target.constructor;
				const targetEventsMetadata = Reflect.getOwnMetadata(exports.PLUGIN_EVENTS_METADATA_KEY, TargetType) || [];
				targetEventsMetadata.push({
					key: propertyKey,
					name
				});
				Reflect.defineMetadata(exports.PLUGIN_EVENTS_METADATA_KEY, targetEventsMetadata, TargetType);
			}
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/decorators/index.js
var require_decorators = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Event = exports.HttpServer = exports.Storage = exports.Logger = exports.Dependency = exports.Plugin = void 0;
	var plugin_1 = require_plugin$2();
	Object.defineProperty(exports, "Plugin", {
		enumerable: true,
		get: function() {
			return plugin_1.Plugin;
		}
	});
	var dependency_1 = require_dependency();
	Object.defineProperty(exports, "Dependency", {
		enumerable: true,
		get: function() {
			return dependency_1.Dependency;
		}
	});
	Object.defineProperty(exports, "Logger", {
		enumerable: true,
		get: function() {
			return dependency_1.Logger;
		}
	});
	Object.defineProperty(exports, "Storage", {
		enumerable: true,
		get: function() {
			return dependency_1.Storage;
		}
	});
	Object.defineProperty(exports, "HttpServer", {
		enumerable: true,
		get: function() {
			return dependency_1.HttpServer;
		}
	});
	var event_1 = require_event$1();
	Object.defineProperty(exports, "Event", {
		enumerable: true,
		get: function() {
			return event_1.Event;
		}
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/plugin/index.js
var require_plugin$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$13) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$13, p)) __createBinding(exports$13, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_plugin$3(), exports);
	__exportStar(require_plugin_activity_event(), exports);
	__exportStar(require_plugin_activity_sent_event(), exports);
	__exportStar(require_plugin_activity_response_event(), exports);
	__exportStar(require_plugin_error_event(), exports);
	__exportStar(require_plugin_start_event(), exports);
	__exportStar(require_sender(), exports);
	__exportStar(require_decorators(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/prefixed.js
var require_prefixed = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/route-handler.js
var require_route_handler = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/streamer.js
var require_streamer = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StreamCancelledError = void 0;
	/**
	* Raised when Teams cancels a stream (403) or when a stream operation is attempted after cancellation.
	*/
	var StreamCancelledError = class extends Error {
		constructor(message) {
			super(message ?? "stream canceled");
			this.name = "StreamCancelledError";
		}
	};
	exports.StreamCancelledError = StreamCancelledError;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/suffixed.js
var require_suffixed = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/union-to-intersection.js
var require_union_to_intersection = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/types/index.js
var require_types = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$12) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$12, p)) __createBinding(exports$12, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_app_events$1(), exports);
	__exportStar(require_event_handler(), exports);
	__exportStar(require_plugin$1(), exports);
	__exportStar(require_prefixed(), exports);
	__exportStar(require_route_handler(), exports);
	__exportStar(require_streamer(), exports);
	__exportStar(require_suffixed(), exports);
	__exportStar(require_union_to_intersection(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/asserts.js
var require_asserts = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.assertNever = void 0;
	const assert_1 = __importDefault(__require("assert"));
	const assertNever = (value, message) => {
		(0, assert_1.default)(false, message ?? `Unexpected value: ${value}`);
	};
	exports.assertNever = assertNever;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/promises/retry.js
var require_retry = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.retry = retry;
	const types_1 = require_types();
	async function retry(factory, options) {
		const max = options?.max ?? 5;
		const delay = options?.delay ?? 500;
		const log = options?.logger?.child("retry");
		try {
			return await factory();
		} catch (err) {
			if (err instanceof types_1.StreamCancelledError || err instanceof Error && err.name === "StreamCancelledError") throw err;
			if (max > 1) {
				log?.debug(`delaying ${delay}ms...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
				log?.debug("retrying...");
				return retry(factory, {
					max: max - 1,
					delay: delay * 2,
					logger: options?.logger
				});
			}
			log?.error(err);
			throw err;
		}
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/promises/index.js
var require_promises = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$11) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$11, p)) __createBinding(exports$11, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_retry(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/function-context.js
var require_function_context = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getConversationIdResolver = getConversationIdResolver;
	function getConversationIdResolver(app, log, context) {
		let state;
		const { userId, userName, tenantId } = context;
		const conversationId = context.chatId ?? context.channelId;
		return async () => {
			if (state) return state.id;
			if (!conversationId) try {
				state = { id: (await app.api.conversations.create({
					members: [{
						id: userId,
						role: "user",
						name: userName
					}],
					tenantId
				})).id };
			} catch {
				state = { id: void 0 };
				log.error("failed to create conversation with user", { userId });
			}
			else {
				try {
					state = { id: !await app.api.conversations.members(conversationId).getById(userId) ? void 0 : conversationId };
				} catch {
					state = { id: void 0 };
				}
				if (!state.id) log.warn("either the bot or the user are not in this conversation", {
					conversationId,
					userId
				});
			}
			return state.id;
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/thread.js
var require_thread = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toThreadedConversationId = toThreadedConversationId;
	/**
	* Constructs a threaded conversation ID by appending `;messageid={messageId}`
	* to the conversation ID. This is the format APX uses to route messages
	* to a specific thread.
	*
	* @param conversationId the conversation to thread into (e.g. `19:abc@thread.skype`)
	* @param messageId the thread root message ID (must be a non-zero numeric string)
	* @returns the threaded conversation ID (e.g. `19:abc@thread.skype;messageid=123`)
	*/
	function toThreadedConversationId(conversationId, messageId) {
		if (!conversationId) throw new Error("conversationId must be a non-empty string");
		if (!messageId || !/^\d+$/.test(messageId) || messageId === "0") throw new Error(`Invalid messageId "${messageId}": must be a non-zero numeric value`);
		return `${conversationId.split(";")[0]};messageid=${messageId}`;
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/utils/index.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toThreadedConversationId = exports.functionContext = exports.promises = exports.asserts = void 0;
	exports.asserts = __importStar(require_asserts());
	exports.promises = __importStar(require_promises());
	exports.functionContext = __importStar(require_function_context());
	var thread_1 = require_thread();
	Object.defineProperty(exports, "toThreadedConversationId", {
		enumerable: true,
		get: function() {
			return thread_1.toThreadedConversationId;
		}
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/http/http-stream.js
var require_http_stream = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HttpStream = void 0;
	const teams_api_1 = require_dist$2();
	const teams_common_1 = require_dist$3();
	const types_1 = require_types();
	const utils_1 = require_utils();
	/**
	* HTTP-based streaming implementation for Microsoft Teams activities.
	*
	* Allows sending typing indicators and messages in chunks to Teams.
	* Queues incoming activities and flushes them periodically to avoid
	* rate limits.
	*
	* Flow:
	* 1. `emit()` adds activities to the queue and starts a flush if none scheduled.
	* 2. `_flush()` starts by cancelling any pending flush, then processes up to 10 queued activities under a lock.
	* 3. Informative typing updates are sent immediately.
	* 4. Message text is combined and sent as a typing activity.
	* 5. `_flush()` schedules another flush if more items remain in queue.
	* 6. `close()` waits for the queue to empty and sends the final message activity.
	*/
	var HttpStream = class {
		events = new teams_common_1.EventEmitter();
		client;
		ref;
		index = 0;
		id;
		text = "";
		attachments = [];
		channelData = {};
		entities = [];
		queue = [];
		_result;
		_timeout;
		_logger;
		_flushing = false;
		_canceled = false;
		_totalTimeout = 3e4;
		/**
		* Whether the stream has been canceled.
		* For example when the user pressed the Stop button or the 2-minute timeout has exceeded.
		*/
		get canceled() {
			return this._canceled;
		}
		constructor(client, ref, logger) {
			this.client = client;
			this.ref = ref;
			this._logger = logger?.child("stream") || new teams_common_1.ConsoleLogger("@teams/http-stream");
		}
		/**
		* Emit a new activity or text to the stream.
		* @param activity Activity object or string message.
		*/
		emit(activity) {
			if (this._canceled) throw new types_1.StreamCancelledError();
			if (typeof activity === "string") activity = {
				type: "message",
				text: activity
			};
			this.queue.push(activity);
			if (!this._timeout) this.flush();
		}
		/**
		* Send a typing/status update without adding to the main text.
		* @param text Status text (ex. "Thinking...")
		*/
		update(text) {
			this.emit({
				type: "typing",
				text,
				channelData: { streamType: "informative" }
			});
		}
		/**
		* Close the stream by sending the final message.
		* Waits for all queued activities to flush.
		*/
		async close() {
			if (!this.index && !this.queue.length && !this._flushing) {
				this._logger.debug("closed with no content");
				return;
			}
			if (this._result) {
				this._logger.debug("already closed");
				return this._result;
			}
			if (this._canceled) {
				this._logger.debug("stream canceled, nothing to close");
				return;
			}
			const start = Date.now();
			while ((this.queue.length || !this.id || this._flushing) && !this._canceled) {
				if (Date.now() - start > this._totalTimeout) {
					this._logger.warn("Timeout while waiting for id and queue to flush");
					return;
				}
				this._logger.debug("waiting for id to be set or queue to be empty");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (this._canceled) {
				this._logger.debug("stream canceled, nothing to close");
				return;
			}
			if (!this.id) {
				this._logger.warn("no stream id set, cannot close stream");
				return;
			}
			if (this.text === "" && !this.attachments.length) {
				this._logger.warn("no text or attachments to send, cannot close stream");
				return;
			}
			const activity = new teams_api_1.MessageActivity(this.text).withId(this.id).addAttachments(...this.attachments).addEntities(...this.entities).withChannelData(this.channelData).addStreamFinal();
			const res = await utils_1.promises.retry(() => this.send(activity), { logger: this._logger });
			this.events.emit("close", res);
			this.index = 0;
			this.id = void 0;
			this.text = "";
			this.attachments = [];
			this.channelData = {};
			this.entities = [];
			this._result = res;
			this._logger.debug(res);
			return res;
		}
		/**
		* Flush queued activities.
		* Processes up to 10 items at a time.
		*/
		async flush() {
			if (!this.queue.length || this._flushing) return;
			this._flushing = true;
			try {
				if (this._timeout) {
					clearTimeout(this._timeout);
					this._timeout = void 0;
				}
				const informativeUpdates = [];
				const startLength = this.queue.length;
				while (this.queue.length) {
					const activity = this.queue.shift();
					if (!activity) continue;
					if (activity.type === "message") {
						if (activity.text) this.text += activity.text;
						if (activity.attachments) this.attachments = [...this.attachments || [], ...activity.attachments];
						if (activity.entities) this.entities = [...this.entities || [], ...activity.entities];
					}
					if (activity.type === "typing") {
						if (activity.channelData?.streamType === "informative" && this.text === "") informativeUpdates.push(activity);
					}
					if (activity.channelData) this.channelData = {
						...this.channelData,
						...activity.channelData
					};
				}
				if (startLength === 0) return;
				for (const informativeUpdate of informativeUpdates) {
					const activity = new teams_api_1.TypingActivity().withText(informativeUpdate.text || "").withChannelData({ streamType: "informative" });
					await this.pushStreamChunk(activity);
				}
				if (this.text) {
					const activity = new teams_api_1.TypingActivity().withText(this.text);
					await this.pushStreamChunk(activity);
				}
				if (this.queue.length) this._timeout = setTimeout(this.flush.bind(this), 500);
			} catch (err) {
				if (!(err instanceof types_1.StreamCancelledError)) this._logger.error(err, "flush failed");
			} finally {
				this._flushing = false;
			}
		}
		/**
		* Push a new chunk to the stream.
		* @param activity TypingActivity to send.
		*/
		async pushStreamChunk(activity) {
			if (this.id) activity.id = this.id;
			activity.addStreamUpdate(this.index + 1);
			const res = await utils_1.promises.retry(() => this.send(activity), { logger: this._logger });
			this.events.emit("chunk", res);
			this.index++;
			if (!this.id) this.id = res.id;
		}
		/**
		* Send or update a streaming activity
		* @param activity ActivityParams to send.
		*/
		async send(activity) {
			if (this._canceled) throw new types_1.StreamCancelledError();
			activity = {
				...activity,
				from: this.ref.bot,
				conversation: this.ref.conversation
			};
			try {
				if (activity.id && !(activity.entities?.some((e) => e.type === "streaminfo") || false)) {
					const res = await this.client.conversations.activities(this.ref.conversation.id).update(activity.id, activity);
					return {
						...activity,
						...res
					};
				}
				const res = await this.client.conversations.activities(this.ref.conversation.id).create(activity);
				return {
					...activity,
					...res
				};
			} catch (err) {
				if (err?.response?.status === 403) {
					this._canceled = true;
					this._logger.debug("stream canceled by Teams (403)");
					throw new types_1.StreamCancelledError();
				}
				throw err;
			}
		}
	};
	exports.HttpStream = HttpStream;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/activity-sender.js
var require_activity_sender = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ActivitySender = void 0;
	const teams_api_1 = require_dist$2();
	const http_stream_1 = require_http_stream();
	/**
	* Handles sending activities to the Bot Framework
	* Separate from transport concerns (HTTP, WebSocket, etc.)
	*/
	var ActivitySender = class {
		client;
		logger;
		constructor(client, logger) {
			this.client = client;
			this.logger = logger;
		}
		async send(activity, ref) {
			const api = new teams_api_1.Client(ref.serviceUrl, this.client);
			activity = {
				...activity,
				from: ref.bot,
				conversation: ref.conversation
			};
			const isTargeted = activity.recipient?.isTargeted === true;
			if (isTargeted && ref.conversation.conversationType === "personal") throw new Error("Targeted messages are not supported in 1:1 (personal) chats.");
			if (activity.id) {
				const res = isTargeted ? await api.conversations.activities(ref.conversation.id).updateTargeted(activity.id, activity) : await api.conversations.activities(ref.conversation.id).update(activity.id, activity);
				return {
					...activity,
					...res
				};
			}
			const res = isTargeted ? await api.conversations.activities(ref.conversation.id).createTargeted(activity) : await api.conversations.activities(ref.conversation.id).create(activity);
			return {
				...activity,
				...res
			};
		}
		createStream(ref) {
			const api = new teams_api_1.Client(ref.serviceUrl, this.client);
			return new http_stream_1.HttpStream(api, ref, this.logger);
		}
	};
	exports.ActivitySender = ActivitySender;
}));
//#endregion
//#region node_modules/@microsoft/teams.graph/dist/index.js
var require_dist$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_common = require_dist$3(), O = require_lib$2();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var O__default = /* @__PURE__ */ _interopDefault(O);
	function b(a, t, e) {
		let s = {};
		for (let r of t.query ?? []) s[r] = e[r];
		for (let r of t.path ?? []) a = a.replace(`{${r}}`, e[r]);
		return `${a}${O__default.default.stringify(s, {
			addQueryPrefix: true,
			arrayFormat: "comma"
		})}`;
	}
	function y(a, t, e) {
		let s = (a.header ?? []).reduce((r, n) => (t[n] && (r[n] = t[n]), r), {});
		return Object.keys(s).length === 0 ? e : {
			...e,
			headers: {
				...e?.headers,
				...s
			}
		};
	}
	var h = class extends Error {
		statusCode;
		code;
		body;
		source;
		constructor(t, e, s, r, n) {
			let i = e && typeof e == "object" && "error" in e ? e.error : void 0, c = i?.message ? `Graph ${s.toUpperCase()} ${r} failed (${t}): ${i.message}` : `Graph ${s.toUpperCase()} ${r} failed with status ${t}`;
			super(c), this.name = "GraphError", this.statusCode = t, this.code = i?.code, Object.defineProperty(this, "body", {
				value: e,
				enumerable: false,
				writable: true,
				configurable: true
			}), n !== void 0 && Object.defineProperty(this, "source", {
				value: n,
				enumerable: false,
				writable: true,
				configurable: true
			});
		}
	}, w = "https://graph.microsoft.com", C = class {
		baseUrlRoot;
		_http;
		betaHttp;
		get http() {
			return this._http;
		}
		constructor(t, e) {
			this.baseUrlRoot = e?.baseUrlRoot ?? t?.baseUrlRoot ?? w, t ? "request" in t ? this._http = t.clone({
				baseUrl: `${this.baseUrlRoot}/v1.0`,
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "teams.ts[graph]/0.0.0"
				}
			}) : this._http = new teams_common.Client({
				...t,
				baseUrl: `${this.baseUrlRoot}/v1.0`,
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "teams.ts[graph]/0.0.0",
					...t.headers
				}
			}) : this._http = new teams_common.Client({
				baseUrl: `${this.baseUrlRoot}/v1.0`,
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "teams.ts[graph]/0.0.0"
				}
			});
		}
		async call(t, ...e) {
			let s = e[e.length - 1], r = e.length > t.length && s && typeof s == "object" && "requestConfig" in s, n = r ? e.slice(0, -1) : e, i = r ? s : void 0, { ver: c = "v1.0", method: p, path: _, paramDefs: u = {}, params: d = {}, body: U } = t(...n), l = b(_, u, d), f = y(u, d, i?.requestConfig), g = this.getHttpClient(c);
			try {
				switch (p) {
					case "delete":
					case "get": return (await g[p](l, f)).data;
					case "patch":
					case "post":
					case "put": return (await g[p](l, U, f)).data;
					default: throw new Error(`Unsupported HTTP method: ${p}`);
				}
			} catch (o) {
				if (o && typeof o == "object" && "isAxiosError" in o && "response" in o && o.response) {
					let { response: m } = o;
					throw new h(m.status, m.data, p, l, o);
				}
				throw o;
			}
		}
		getHttpClient(t) {
			return t === "v1.0" ? this._http : (this.betaHttp = this.betaHttp ?? this._http.clone({ baseUrl: `${this.baseUrlRoot}/beta` }), this.betaHttp);
		}
	};
	exports.Client = C;
	exports.GraphError = h;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/api.js
var require_api = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GraphClient = exports.ApiClient = void 0;
	var teams_api_1 = require_dist$2();
	Object.defineProperty(exports, "ApiClient", {
		enumerable: true,
		get: function() {
			return teams_api_1.Client;
		}
	});
	var teams_graph_1 = require_dist$1();
	Object.defineProperty(exports, "GraphClient", {
		enumerable: true,
		get: function() {
			return teams_graph_1.Client;
		}
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js
var require_jwt_validator = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createEntraTokenValidator = exports.JwtValidator = void 0;
	const jsonwebtoken_1 = __importDefault(require_jsonwebtoken());
	const jwks_rsa_1 = __importDefault(require_src());
	const teams_common_1 = require_dist$3();
	const asserts_1 = require_asserts();
	const DEFAULTS = { clockTolerance: 300 };
	var JwtValidator = class {
		options;
		logger;
		jwksCache = /* @__PURE__ */ new Map();
		constructor(options, logger) {
			this.options = options;
			this.logger = logger?.child("jwt-validator") ?? new teams_common_1.ConsoleLogger("jwt-validator");
		}
		/**
		* Validates a JWT token using the configured options
		*/
		async validateAccessToken(rawToken, overrideOptions) {
			if (!rawToken) throw new Error("No token provided");
			return new Promise((resolve) => {
				const verifyOptions = {
					audience: [
						this.options.clientId,
						`api://botid-${this.options.clientId}`,
						`api://${this.options.clientId}`,
						...this.options.audience ?? []
					],
					issuer: void 0,
					ignoreExpiration: false,
					algorithms: ["RS256"],
					clockTolerance: this.options.clockTolerance ?? DEFAULTS.clockTolerance
				};
				this.logger?.debug("Validating JWT token with options:", {
					audience: verifyOptions.audience,
					clockTolerance: verifyOptions.clockTolerance,
					algorithms: verifyOptions.algorithms
				});
				jsonwebtoken_1.default.verify(rawToken, this.getSigningKey.bind(this), verifyOptions, (err, decoded) => {
					if (err) {
						this.logger?.error("JWT verification failed:", err);
						resolve(null);
						return;
					}
					if (!decoded || typeof decoded !== "object") {
						this.logger?.error("Decoded token is not a valid object:", decoded);
						resolve(null);
						return;
					}
					this.logger?.debug("JWT verification succeeded");
					const payload = decoded;
					try {
						this.performCustomValidations(payload, overrideOptions);
						this.logger?.debug("Custom validations passed for token");
						resolve(payload);
					} catch (validationError) {
						this.logger?.error("Custom validation failed:", validationError);
						resolve(null);
					}
				});
			});
		}
		getJwksClient() {
			switch (this.options.jwksUriOptions.type) {
				case "tenantId": {
					const cachedClient = this.jwksCache.get(`${this.options.tenantId}`);
					if (cachedClient) {
						this.logger?.debug(`Using cached JWKS client for tenant ID: ${this.options.tenantId}`);
						return cachedClient;
					}
					const loginEndpoint = this.options.loginEndpoint ?? "https://login.microsoftonline.com";
					this.jwksCache.set(`${this.options.tenantId}`, (0, jwks_rsa_1.default)({ jwksUri: `${loginEndpoint}/${this.options.tenantId}/discovery/v2.0/keys` }));
					return this.jwksCache.get(`${this.options.tenantId}`);
				}
				case "uri": {
					const cachedClient = this.jwksCache.get(this.options.jwksUriOptions.uri);
					if (cachedClient) {
						this.logger?.debug(`Using cached JWKS client for URI: ${this.options.jwksUriOptions.uri}`);
						return cachedClient;
					}
					this.jwksCache.set(this.options.jwksUriOptions.uri, (0, jwks_rsa_1.default)({ jwksUri: this.options.jwksUriOptions.uri }));
					return this.jwksCache.get(this.options.jwksUriOptions.uri);
				}
				default: (0, asserts_1.assertNever)(this.options.jwksUriOptions, `Unknown JWKS URI options type: ${this.options.jwksUriOptions}`);
			}
		}
		getSigningKey(header, callback) {
			this.getJwksClient()?.getSigningKey(header.kid, (err, key) => {
				if (err) {
					this.logger?.error("Failed to get signing key:", err);
					callback(err, void 0);
					return;
				}
				const signingKey = key?.getPublicKey();
				callback(null, signingKey);
			});
		}
		validateIssuer(iss) {
			const validateIssuer = this.options.validateIssuer;
			if (!validateIssuer) return;
			if ("allowedIssuer" in validateIssuer) {
				if (!validateIssuer.allowedIssuer) return;
				if (!iss) throw new Error("Token missing issuer claim");
				if (iss !== validateIssuer.allowedIssuer) throw new Error(`Token issuer '${iss}' does not match allowed issuer '${validateIssuer.allowedIssuer}'`);
			}
			if ("allowedTenantIds" in validateIssuer) {
				if (!validateIssuer.allowedTenantIds?.length) return;
				if (!iss) throw new Error("Token missing issuer claim");
				if (!this.options.tenantId) throw new Error("Tenant ID is required when allowedTenantIds is configured");
				const isMultiTenant = [
					"common",
					"organizations",
					"consumers"
				].includes(this.options.tenantId);
				const allowedTenantIds = [];
				if (isMultiTenant) {
					for (const tenantId of validateIssuer.allowedTenantIds) if (![
						"common",
						"organizations",
						"consumers"
					].includes(tenantId)) allowedTenantIds.push(tenantId);
				} else allowedTenantIds.push(this.options.tenantId);
				if (allowedTenantIds.length === 0) return;
				const issuerEndpoints = [this.options.loginEndpoint ?? "https://login.microsoftonline.com", "https://sts.windows.net"];
				if (!allowedTenantIds.some((tenantId) => issuerEndpoints.some((endpoint) => iss.startsWith(`${endpoint}/${tenantId}/`)))) throw new Error(`Token issuer '${iss}' not in allowed tenant IDs: ${allowedTenantIds.join(", ")}`);
			}
		}
		validateScope(scp, overrideValidateScope) {
			const validateScope = overrideValidateScope || this.options.validateScope;
			if (validateScope) {
				if (!new Set((scp ?? "").split(" ")).has(validateScope.requiredScope)) throw new Error(`Token missing required scope: ${validateScope.requiredScope}`);
			}
		}
		validateServiceUrl(serviceUrl, overrideValidateServiceUrl) {
			const validateServiceUrl = overrideValidateServiceUrl || this.options.validateServiceUrl;
			if (validateServiceUrl) {
				if (!serviceUrl) throw new Error("Token missing serviceurl claim");
				const normalizedTokenUrl = serviceUrl.replace(/\/$/, "").toLowerCase();
				const normalizedExpectedUrl = validateServiceUrl.expectedServiceUrl.replace(/\/$/, "").toLowerCase();
				if (normalizedTokenUrl !== normalizedExpectedUrl) throw new Error(`Service URL mismatch. Token: ${normalizedTokenUrl}, Expected: ${normalizedExpectedUrl}`);
			}
		}
		performCustomValidations(payload, overrideOptions) {
			this.validateIssuer(payload.iss);
			this.validateScope(payload.scp, overrideOptions?.validateScope);
			this.validateServiceUrl(payload.serviceurl, overrideOptions?.validateServiceUrl);
		}
	};
	exports.JwtValidator = JwtValidator;
	const createEntraTokenValidator = (tenantId, clientId, options) => {
		return new JwtValidator({
			clientId,
			tenantId,
			loginEndpoint: options?.loginEndpoint,
			audience: options?.applicationIdUri ? [options.applicationIdUri] : void 0,
			validateIssuer: { allowedTenantIds: options?.allowedTenantIds },
			validateScope: options?.requiredScope ? { requiredScope: options.requiredScope } : void 0,
			jwksUriOptions: { type: "tenantId" }
		}, options?.logger);
	};
	exports.createEntraTokenValidator = createEntraTokenValidator;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/auth/remote-function-validator.js
var require_remote_function_validator = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RemoteFunctionValidator = void 0;
	const jwt_validator_1 = require_jwt_validator();
	exports.RemoteFunctionValidator = class RemoteFunctionValidator {
		entraTokenValidator;
		logger;
		constructor(entraTokenValidator, logger) {
			this.entraTokenValidator = entraTokenValidator;
			this.logger = logger;
		}
		/**
		* Create a remote function validator for Entra tokens
		*/
		static create(tenantId, clientId, logger, options) {
			return new RemoteFunctionValidator(new jwt_validator_1.JwtValidator({
				clientId,
				tenantId,
				validateIssuer: { allowedTenantIds: options?.allowedTenantIds },
				validateScope: options?.requiredScope ? { requiredScope: options.requiredScope } : void 0,
				jwksUriOptions: { type: "tenantId" }
			}, logger), logger);
		}
		async check(headers) {
			const h = (key) => {
				const v = headers[key];
				return Array.isArray(v) ? v[0] : v;
			};
			const appSessionId = h("x-teams-app-session-id");
			const pageId = h("x-teams-page-id");
			const authorization = h("authorization")?.split(" ");
			const authToken = authorization?.length === 2 && authorization[0].toLowerCase() === "bearer" ? authorization[1] : "";
			const tokenPayload = await this.entraTokenValidator.validateAccessToken(authToken);
			if (!pageId || !appSessionId || !authToken || !tokenPayload) {
				this.logger.debug("unauthorized - missing required headers or invalid token");
				return null;
			}
			return {
				appId: tokenPayload?.["appId"],
				appSessionId,
				authToken,
				channelId: h("x-teams-channel-id"),
				chatId: h("x-teams-chat-id"),
				meetingId: h("x-teams-meeting-id"),
				messageId: h("x-teams-message-id"),
				pageId,
				subPageId: h("x-teams-sub-page-id"),
				teamId: h("x-teams-team-id"),
				tenantId: tokenPayload["tid"],
				userId: tokenPayload["oid"],
				userName: tokenPayload["name"]
			};
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.embed.js
var require_app_embed = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.func = func;
	exports.tab = tab;
	exports.configTab = configTab;
	const remote_function_validator_1 = require_remote_function_validator();
	const utils_1 = require_utils();
	/**
	* add/update a function that can be called remotely
	* @param name The unique function name
	* @param cb The callback to handle the function
	*/
	function func(name, cb) {
		const log = this.log.child("functions").child(name);
		const entraTokenValidator = this.entraTokenValidator;
		const validator = entraTokenValidator ? new remote_function_validator_1.RemoteFunctionValidator(entraTokenValidator, log) : null;
		this.server.registerRoute("POST", `/api/functions/${name}`, async ({ body, headers }) => {
			if (!validator) {
				log.debug("unauthorized - no token validator configured");
				return {
					status: 401,
					body: "unauthorized"
				};
			}
			const context = await validator.check(headers);
			if (!context) return {
				status: 401,
				body: "unauthorized"
			};
			const getCurrentConversationId = utils_1.functionContext.getConversationIdResolver(this, log.child("getCurrentConversationId"), context);
			const send = async (activity) => {
				const conversationId = await getCurrentConversationId();
				return !conversationId ? null : await this.send(conversationId, activity);
			};
			return {
				status: 200,
				body: await cb({
					...context,
					log,
					api: this.api,
					appGraph: this.graph,
					data: body,
					getCurrentConversationId,
					send
				})
			};
		});
		return this;
	}
	/**
	* add/update a static tab.
	* the tab will be hosted at
	* `http://localhost:{{PORT}}/tabs/{{name}}` or `https://{{BOT_DOMAIN}}/tabs/{{name}}`
	* @remark scopes default to `personal`
	* @param name A unique identifier for the entity which the tab displays.
	* @param path The path to the web `dist` folder.
	*/
	function tab(name, path, options) {
		if (!this._manifest.staticTabs) this._manifest.staticTabs = [];
		const i = this._manifest.staticTabs.findIndex((t) => t.entityId === name);
		const tab = {
			entityId: name,
			contentUrl: `https://\${{BOT_DOMAIN}}/tabs/${name}`,
			scopes: ["personal"],
			...options
		};
		if (i > -1) this._manifest.staticTabs[i] = tab;
		else this._manifest.staticTabs.push(tab);
		this.server.serveStatic(`/tabs/${name}`, path);
		return this;
	}
	/**
	* add a configurable tab
	* @remark scopes defaults to `team`
	* @param url The url to use when configuring the tab.
	*/
	function configTab(url, options) {
		if (!this._manifest.configurableTabs) this._manifest.configurableTabs = [];
		this._manifest.configurableTabs.push({
			configurationUrl: url,
			scopes: ["team"],
			...options
		});
		return this;
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.events.js
var require_app_events = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.event = event;
	exports.onError = onError;
	exports.onActivitySent = onActivitySent;
	exports.onActivityResponse = onActivityResponse;
	/**
	* subscribe to an event
	* @param name the event to subscribe to
	* @param cb the callback to invoke
	*/
	function event(name, cb) {
		this.events.on(name, cb);
		return this;
	}
	async function onError(event) {
		for (const plugin of this.plugins) if (plugin.onError) await plugin.onError(event);
		this.events.emit("error", event);
	}
	async function onActivitySent(event) {
		for (const plugin of this.plugins) if (plugin.onActivitySent) await plugin.onActivitySent(event);
		this.events.emit("activity.sent", event);
	}
	async function onActivityResponse(event) {
		for (const plugin of this.plugins) if (plugin.onActivityResponse) await plugin.onActivityResponse(event);
		this.events.emit("activity.response", event);
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.oauth.js
var require_app_oauth = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.onTokenExchange = onTokenExchange;
	exports.onVerifyState = onVerifyState;
	exports.onSignInFailure = onSignInFailure;
	const axios_1 = require_axios();
	const teams_graph_1 = require_dist$1();
	async function onTokenExchange(ctx) {
		const { api, activity, log, next } = ctx;
		if (this.oauth.defaultConnectionName !== activity.value.connectionName) log.warn(`default connection name "${this.oauth.defaultConnectionName}" does not match activity connection name "${activity.value.connectionName}"`);
		try {
			const token = await api.users.token.exchange({
				channelId: activity.channelId,
				userId: activity.from.id,
				connectionName: activity.value.connectionName,
				exchangeRequest: { token: activity.value.token }
			});
			ctx.userGraph = new teams_graph_1.Client(this.client.clone({ token: token.token }), { baseUrlRoot: this.graphBaseUrl });
			this.events.emit("signin", {
				...ctx,
				token,
				isSignedIn: true
			});
			next(ctx);
			return { status: 200 };
		} catch (error) {
			if (error instanceof axios_1.AxiosError) {
				if (error.status !== 404 && error.status !== 400 && error.status !== 412) {
					this.events.emit("error", {
						error,
						activity
					});
					return { status: error.status || 500 };
				}
			}
			return {
				status: 412,
				body: {
					id: activity.value.id,
					connectionName: activity.value.connectionName,
					failureDetail: "unable to exchange token..."
				}
			};
		}
	}
	async function onVerifyState(ctx) {
		const { log, api, activity, next } = ctx;
		try {
			if (!activity.value.state) {
				log.warn(`auth state not found for conversation "${activity.conversation.id}" and user "${activity.from.id}"`);
				return { status: 404 };
			}
			const token = await api.users.token.get({
				channelId: activity.channelId,
				userId: activity.from.id,
				connectionName: this.oauth.defaultConnectionName,
				code: activity.value.state
			});
			ctx.userGraph = new teams_graph_1.Client(this.client.clone({ token: token.token }), { baseUrlRoot: this.graphBaseUrl });
			this.events.emit("signin", {
				...ctx,
				token,
				isSignedIn: true
			});
			next(ctx);
			return { status: 200 };
		} catch (error) {
			if (error instanceof axios_1.AxiosError) {
				if (error.status !== 404 && error.status !== 400 && error.status !== 412) {
					this.events.emit("error", {
						error,
						activity
					});
					return { status: error.status || 500 };
				}
			}
			return { status: 412 };
		}
	}
	/**
	* Default handler for signin/failure invoke activities.
	*
	* Teams sends a signin/failure invoke when SSO token exchange fails
	* (e.g., due to a misconfigured Entra app registration). This handler
	* logs the failure details and emits an error event so developers are
	* notified rather than having the failure silently swallowed.
	*
	* Known failure codes (sent by the Teams client):
	* - `installappfailed`: Failed to install the app in the user's personal scope (non-silent).
	* - `authrequestfailed`: The SSO auth request failed after app installation (non-silent).
	* - `installedappnotfound`: The bot app is not installed for the user or group chat.
	* - `invokeerror`: A generic error occurred during the SSO invoke flow.
	* - `resourcematchfailed`: The token exchange resource URI on the OAuthCard does not
	*   match the Application ID URI in the Entra app registration's "Expose an API" section.
	* - `oauthcardnotvalid`: The bot's OAuthCard could not be parsed.
	* - `tokenmissing`: AAD token acquisition failed.
	* - `userconsentrequired`: The user needs to consent (handled via OAuth card fallback,
	*   does not typically reach the bot).
	* - `interactionrequired`: User interaction is required (handled via OAuth card fallback,
	*   does not typically reach the bot).
	*/
	async function onSignInFailure(ctx) {
		const { log, activity, next } = ctx;
		const { code, message } = activity.value;
		log.warn(`sign-in failed for user "${activity.from.id}" in conversation "${activity.conversation.id}": ${code} — ${message}. If the code is 'resourcematchfailed', verify that your Entra app registration has 'Expose an API' configured with the correct Application ID URI matching your OAuth connection's Token Exchange URL.`);
		this.events.emit("error", {
			error: /* @__PURE__ */ new Error(`Sign-in failure: ${code} — ${message}`),
			activity
		});
		next(ctx);
		return { status: 200 };
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/events/activity.js
var require_activity$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/events/activity-response.js
var require_activity_response = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/events/activity-sent.js
var require_activity_sent = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/events/error.js
var require_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/events/index.js
var require_events = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$10) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$10, p)) __createBinding(exports$10, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.allIEventKeys = void 0;
	exports.allIEventKeys = Object.keys({
		start: true,
		signin: true,
		error: true,
		activity: true,
		"activity.response": true,
		"activity.sent": true
	});
	__exportStar(require_activity$2(), exports);
	__exportStar(require_activity_response(), exports);
	__exportStar(require_activity_sent(), exports);
	__exportStar(require_error(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.plugins.js
var require_app_plugins = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.plugin = plugin;
	exports.getPlugin = getPlugin;
	exports.inject = inject;
	exports.getMetadata = getMetadata;
	const events_1 = require_events();
	const dependency_1 = require_dependency();
	const event_1 = require_event$1();
	const plugin_1 = require_plugin$2();
	/**
	* add a plugin
	* @param plugin plugin to add
	*/
	function plugin(plugin) {
		const { name } = getMetadata(plugin);
		if (this.getPlugin(name)) throw new Error(`duplicate plugin "${name}" found`);
		this.plugins.push(plugin);
		this.container.register(name, { useValue: plugin });
		if (plugin.constructor.name !== name) this.container.register(plugin.constructor.name, { useValue: plugin });
		return this;
	}
	/**
	* get a plugin
	*/
	function getPlugin(name) {
		return this.plugins.find((plugin) => {
			return getMetadata(plugin).name === name;
		});
	}
	/**
	* inject fields/events into a plugin
	*/
	function inject(plugin) {
		const { name, dependencies, events } = getMetadata(plugin);
		for (const { key, type, optional } of dependencies) {
			let dependency = this.container.resolve(type);
			if (!dependency) dependency = this.container.resolve(key);
			if (!dependency) {
				if (optional) continue;
				throw new Error(`dependency "${type}" of property "${key}" not found, but plugin "${name}" depends on it`);
			}
			if (type === "ILogger") dependency = dependency.child(name);
			Object.defineProperty(plugin, key, {
				value: dependency,
				writable: true,
				enumerable: false,
				configurable: false
			});
		}
		for (const { key, name } of events) {
			let handler = (..._) => {};
			if (name === "error") handler = (event) => {
				this.onError(event);
			};
			else if (name === "activity") handler = (event) => {
				return this.onActivity(event);
			};
			else if (name === "custom") handler = (name, event) => {
				if (events_1.allIEventKeys.includes(name)) {
					this.log.warn(`event "${name}" is reserved by core app-events but an plugin is trying to emit it`);
					return;
				}
				this.events.emit(name, event);
			};
			Object.defineProperty(plugin, key, {
				value: handler,
				writable: false,
				enumerable: false,
				configurable: false
			});
		}
	}
	function getMetadata(plugin) {
		if (!Reflect.hasMetadata(plugin_1.PLUGIN_METADATA_KEY, plugin.constructor)) throw new Error(`type "${plugin.constructor.name}" is not a valid plugin`);
		const metadata = Reflect.getMetadata(plugin_1.PLUGIN_METADATA_KEY, plugin.constructor);
		const dependencies = Reflect.getMetadata(dependency_1.PLUGIN_DEPENDENCIES_METADATA_KEY, plugin.constructor) || [];
		const events = Reflect.getMetadata(event_1.PLUGIN_EVENTS_METADATA_KEY, plugin.constructor) || [];
		return {
			...metadata,
			dependencies,
			events
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/activity.js
var require_activity$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ActivityContext = void 0;
	const teams_api_1 = require_dist$2();
	var ActivityContext = class {
		appId;
		activity;
		ref;
		log;
		api;
		appGraph;
		userGraph;
		storage;
		stream;
		isSignedIn;
		connectionName;
		next;
		activitySender;
		constructor(value) {
			const { activitySender, next, ...rest } = value;
			Object.assign(this, rest);
			this.activitySender = activitySender;
			this.next = next;
			this.stream = activitySender.createStream(value.ref);
			this.connectionName = value.connectionName;
			if (value.activity.type === "message") value.activity = teams_api_1.MessageActivity.from(value.activity).toInterface();
			if (value.activity.type === "messageUpdate") value.activity = teams_api_1.MessageUpdateActivity.from(value.activity).toInterface();
			if (value.activity.type === "messageDelete") value.activity = teams_api_1.MessageDeleteActivity.from(value.activity).toInterface();
			if (value.activity.type === "typing") value.activity = teams_api_1.TypingActivity.from(value.activity).toInterface();
		}
		/**
		* send an activity in the current conversation without quoting.
		*
		* In channels, sends to the current thread. In scopes that do not
		* support threading (group chat, meetings), sends as a normal message.
		* To send with a visual quote of the inbound message, use {@link reply}.
		*
		* @param activity the activity to send
		* @param conversationRef optional conversation reference to send to a different conversation or thread
		*/
		async send(activity, conversationRef) {
			const params = (0, teams_api_1.toActivityParams)(activity);
			if (params.type === "message" && params.recipient?.isTargeted && !params.id) {
				if (!params.recipient) params.recipient = this.activity.from;
			}
			if (params.type === "message" && this.activity.recipient?.isTargeted === true) {
				if (params.entities) params.entities = params.entities.filter((e) => e.type !== "quotedReply");
				if (params.text) params.text = params.text.replace(`<quoted messageId="${this.activity.id}"/>`, "").trim();
				if (!params.entities?.some((e) => e.type === "targetedMessageInfo")) {
					if (!params.entities) params.entities = [];
					params.entities.push({
						type: "targetedMessageInfo",
						messageId: this.activity.id
					});
				}
			}
			return await this.activitySender.send(params, conversationRef ?? this.ref);
		}
		/**
		* send an activity in the current conversation with a visual quote
		* of the inbound message.
		*
		* In channels, sends to the current thread with a quoted reply.
		* In other scopes, sends with a quoted reply.
		* To send without quoting, use {@link send}.
		*
		* @param activity the activity to send
		*/
		async reply(activity) {
			activity = (0, teams_api_1.toActivityParams)(activity);
			activity.replyToId = this.activity.id;
			if (activity.type === "message" && activity.text) {
				const blockQuote = this.buildBlockQuoteForActivity();
				if (blockQuote) activity.text = `${blockQuote}\r\n${activity.text}`;
			}
			return this.send(activity);
		}
		async signin(options) {
			const { oauthCardText, signInButtonText, connectionName, signInLink, overrideSignInActivity } = {
				oauthCardText: "Please Sign In...",
				signInButtonText: "Sign In",
				...options
			};
			const convo = { ...this.ref };
			try {
				return (await this.api.users.token.get({
					channelId: this.activity.channelId,
					userId: this.activity.from.id,
					connectionName: connectionName || this.connectionName
				})).token;
			} catch (err) {}
			const tokenExchangeState = {
				connectionName: connectionName || this.connectionName,
				conversation: convo,
				relatesTo: this.activity.relatesTo,
				msAppId: this.appId
			};
			if (this.activity.conversation.isGroup) {
				const res = await this.api.conversations.create({
					tenantId: this.activity.conversation.tenantId,
					members: [this.activity.from]
				});
				await this.send({
					type: "message",
					text: oauthCardText
				});
				convo.conversation = { id: res.id };
			}
			const state = Buffer.from(JSON.stringify(tokenExchangeState)).toString("base64");
			const resource = await this.api.bots.signIn.getResource({ state });
			await this.send(overrideSignInActivity?.(resource.tokenExchangeResource, resource.tokenPostResource, resource.signInLink) ?? {
				type: "message",
				inputHint: "acceptingInput",
				recipient: this.activity.from,
				conversation: convo.conversation,
				attachments: [(0, teams_api_1.cardAttachment)("oauth", {
					text: oauthCardText,
					connectionName: connectionName || this.connectionName,
					tokenExchangeResource: resource.tokenExchangeResource,
					tokenPostResource: resource.tokenPostResource,
					buttons: [{
						type: "signin",
						title: signInButtonText,
						value: signInLink || resource.signInLink
					}]
				})]
			}, convo);
		}
		async signout(connectionName) {
			await this.api.users.token.signOut({
				channelId: this.activity.channelId,
				userId: this.activity.from.id,
				connectionName: connectionName || this.connectionName
			});
		}
		toInterface() {
			return {
				activity: this.activity,
				api: this.api,
				appGraph: this.appGraph,
				userGraph: this.userGraph,
				appId: this.appId,
				log: this.log,
				ref: this.ref,
				storage: this.storage,
				stream: this.stream,
				isSignedIn: this.isSignedIn,
				connectionName: this.connectionName,
				userToken: this.userToken,
				next: this.next.bind(this),
				reply: this.reply.bind(this),
				send: this.send.bind(this),
				signin: this.signin.bind(this),
				signout: this.signout.bind(this)
			};
		}
		buildBlockQuoteForActivity() {
			if (this.activity.type === "message" && this.activity.text) {
				const maxLength = 120;
				const truncatedText = this.activity.text.length > maxLength ? `${this.activity.text.substring(0, maxLength)}...` : this.activity.text;
				return `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${this.activity.id}">
<strong itemprop="mri" itemid="${this.activity.from.id}">${this.activity.from.name}</strong><span itemprop="time" itemid="${this.activity.id}"></span>
<p itemprop="preview">${truncatedText}</p>
</blockquote>`;
			} else this.log.debug("Skipping building blockquote for activity type:", this.activity.type);
			return null;
		}
	};
	exports.ActivityContext = ActivityContext;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/activity-error.js
var require_activity_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/activity-signin.js
var require_activity_signin = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/client.js
var require_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/function.js
var require_function = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/contexts/index.js
var require_contexts = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$9) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$9, p)) __createBinding(exports$9, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_activity$1(), exports);
	__exportStar(require_activity_error(), exports);
	__exportStar(require_activity_signin(), exports);
	__exportStar(require_client(), exports);
	__exportStar(require_function(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.process.js
var require_app_process = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.$process = $process;
	const teams_api_1 = require_dist$2();
	const api_1 = require_api();
	const contexts_1 = require_contexts();
	const types_1 = require_types();
	/**
	* activity handler called when an inbound activity is received
	* @param event the received activity event
	*/
	async function $process(event) {
		const { token, body } = event;
		if (!body) throw new Error("Activity body is required");
		const activity = body;
		this.log.debug(`activity/${activity.type}${activity.type === "invoke" ? `/${activity.name}` : ""}`);
		let serviceUrl = activity.serviceUrl || token.serviceUrl;
		if (serviceUrl.endsWith("/")) serviceUrl = serviceUrl.slice(0, serviceUrl.length - 1);
		let userToken;
		try {
			userToken = await this.getUserToken(activity.channelId, activity.from.id);
		} catch (err) {}
		const client = this.client.clone();
		const apiClient = new api_1.ApiClient(serviceUrl, this.client.clone({ token: () => this.getBotToken() }), this.options.apiClientSettings);
		const userGraph = new api_1.GraphClient(client.clone({ token: () => userToken }), { baseUrlRoot: this.graphBaseUrl });
		const appGraph = new api_1.GraphClient(client.clone({ token: () => this.getAppGraphToken(activity.conversation.tenantId ?? "common") }), { baseUrlRoot: this.graphBaseUrl });
		const ref = {
			serviceUrl,
			activityId: activity.id,
			bot: activity.recipient,
			channelId: activity.channelId,
			conversation: activity.conversation,
			locale: activity.locale,
			user: activity.from
		};
		const routes = this.router.select(activity);
		let pluginContexts = {};
		for (let i = this.plugins.length - 1; i > -1; i--) {
			const plugin = this.plugins[i];
			if (plugin.onActivity) {
				const additionalPluginContext = await plugin.onActivity({
					...ref,
					activity,
					token
				});
				if (additionalPluginContext) {
					for (const key in additionalPluginContext) if (key in pluginContexts) this.log.warn(`Plugin context key "${key}" already exists. Overriding.`);
					pluginContexts = {
						...pluginContexts,
						...additionalPluginContext
					};
				}
			}
		}
		let i = -1;
		let data = void 0;
		const next = async (ctx) => {
			if (i === routes.length - 1) return data;
			i++;
			const mergedContext = ctx || {
				...context.toInterface(),
				...pluginContexts
			};
			const res = await routes[i](mergedContext);
			if (res) data = res;
			return data;
		};
		const context = new contexts_1.ActivityContext({
			activity,
			next,
			api: apiClient,
			userGraph,
			appGraph,
			appId: this.id || "",
			log: this.log,
			userToken,
			ref,
			storage: this.storage,
			isSignedIn: !!userToken,
			connectionName: this.oauth.defaultConnectionName,
			activitySender: this.activitySender,
			...pluginContexts
		});
		const send = context.send.bind(context);
		context.send = async (activity, conversationRef) => {
			const res = await send(activity, conversationRef ?? ref);
			this.onActivitySent({
				...conversationRef ?? ref,
				activity: res
			});
			return res;
		};
		context.stream.events.on("chunk", (activity) => {
			this.onActivitySent({
				...ref,
				activity
			});
		});
		context.stream.events.once("close", (activity) => {
			this.onActivitySent({
				...ref,
				activity
			});
		});
		let response;
		try {
			const res = await next();
			await context.stream.close();
			if ((0, teams_api_1.isInvokeResponse)(res)) response = res;
			else response = {
				status: 200,
				body: res
			};
			this.onActivityResponse({
				...ref,
				activity,
				response: res
			});
		} catch (error) {
			if (error instanceof types_1.StreamCancelledError || error?.name === "StreamCancelledError") {
				this.log.debug("stream canceled, returning 200");
				await context.stream.close();
				response = { status: 200 };
			} else {
				response = { status: 500 };
				this.onError({
					error,
					activity
				});
			}
			this.onActivityResponse({
				...ref,
				activity,
				response
			});
		}
		return response;
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.routing.js
var require_app_routing = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.on = on;
	exports.message = message;
	exports.use = use;
	/**
	* subscribe to an event
	* @param name event to subscribe to
	* @param cb callback to invoke
	*/
	function on(name, cb) {
		this.router.on(name, cb);
		return this;
	}
	/**
	* subscribe to a message event for a specific pattern
	* @param pattern pattern to match against message text
	* @param cb callback to invoke
	*/
	function message(pattern, cb) {
		this.router.register({
			type: "user",
			select: (activity) => {
				if (activity.type !== "message") return false;
				return new RegExp(pattern).test(activity.text);
			},
			callback: cb
		});
		return this;
	}
	/**
	* register a middleware
	* @param cb callback to invoke
	*/
	function use(cb) {
		this.router.use(cb);
		return this;
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/container/provider.js
var require_provider = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isValueProvider = isValueProvider;
	exports.isFactoryProvider = isFactoryProvider;
	function isValueProvider(provider) {
		return !!provider.useValue;
	}
	function isFactoryProvider(provider) {
		return !!provider.useFactory;
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/container/container.js
var require_container$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Container = void 0;
	require_Reflect();
	const provider_1 = require_provider();
	/**
	* @private
	* a singleton container
	*/
	var Container = class {
		values = /* @__PURE__ */ new Map();
		providers = /* @__PURE__ */ new Map();
		has(key) {
			return this.providers.has(key);
		}
		register(key, provider) {
			if (this.providers.has(key)) throw new Error(`key "${key}" already exists`);
			this.providers.set(key, provider);
		}
		resolve(key) {
			let value = this.values.get(key);
			if (value) return value;
			const provider = this.providers.get(key);
			if (!provider) return;
			if ((0, provider_1.isFactoryProvider)(provider)) value = provider.useFactory();
			else value = provider.useValue;
			this.values.set(key, value);
			return value;
		}
		toString() {
			return Object.entries(this.values).map(([key, value]) => `${key} => ${value}`).join("\n");
		}
	};
	exports.Container = Container;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/container/index.js
var require_container = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$8) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$8, p)) __createBinding(exports$8, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_container$1(), exports);
	__exportStar(require_provider(), exports);
}));
//#endregion
//#region node_modules/object-assign/index.js
/*
object-assign
(c) Sindre Sorhus
@license MIT
*/
var require_object_assign = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var getOwnPropertySymbols = Object.getOwnPropertySymbols;
	var hasOwnProperty = Object.prototype.hasOwnProperty;
	var propIsEnumerable = Object.prototype.propertyIsEnumerable;
	function toObject(val) {
		if (val === null || val === void 0) throw new TypeError("Object.assign cannot be called with null or undefined");
		return Object(val);
	}
	function shouldUseNative() {
		try {
			if (!Object.assign) return false;
			var test1 = /* @__PURE__ */ new String("abc");
			test1[5] = "de";
			if (Object.getOwnPropertyNames(test1)[0] === "5") return false;
			var test2 = {};
			for (var i = 0; i < 10; i++) test2["_" + String.fromCharCode(i)] = i;
			if (Object.getOwnPropertyNames(test2).map(function(n) {
				return test2[n];
			}).join("") !== "0123456789") return false;
			var test3 = {};
			"abcdefghijklmnopqrst".split("").forEach(function(letter) {
				test3[letter] = letter;
			});
			if (Object.keys(Object.assign({}, test3)).join("") !== "abcdefghijklmnopqrst") return false;
			return true;
		} catch (err) {
			return false;
		}
	}
	module.exports = shouldUseNative() ? Object.assign : function(target, source) {
		var from;
		var to = toObject(target);
		var symbols;
		for (var s = 1; s < arguments.length; s++) {
			from = Object(arguments[s]);
			for (var key in from) if (hasOwnProperty.call(from, key)) to[key] = from[key];
			if (getOwnPropertySymbols) {
				symbols = getOwnPropertySymbols(from);
				for (var i = 0; i < symbols.length; i++) if (propIsEnumerable.call(from, symbols[i])) to[symbols[i]] = from[symbols[i]];
			}
		}
		return to;
	};
}));
//#endregion
//#region node_modules/vary/index.js
/*!
* vary
* Copyright(c) 2014-2017 Douglas Christopher Wilson
* MIT Licensed
*/
var require_vary = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* Module exports.
	*/
	module.exports = vary;
	module.exports.append = append;
	/**
	* RegExp to match field-name in RFC 7230 sec 3.2
	*
	* field-name    = token
	* token         = 1*tchar
	* tchar         = "!" / "#" / "$" / "%" / "&" / "'" / "*"
	*               / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
	*               / DIGIT / ALPHA
	*               ; any VCHAR, except delimiters
	*/
	var FIELD_NAME_REGEXP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
	/**
	* Append a field to a vary header.
	*
	* @param {String} header
	* @param {String|Array} field
	* @return {String}
	* @public
	*/
	function append(header, field) {
		if (typeof header !== "string") throw new TypeError("header argument is required");
		if (!field) throw new TypeError("field argument is required");
		var fields = !Array.isArray(field) ? parse(String(field)) : field;
		for (var j = 0; j < fields.length; j++) if (!FIELD_NAME_REGEXP.test(fields[j])) throw new TypeError("field argument contains an invalid header name");
		if (header === "*") return header;
		var val = header;
		var vals = parse(header.toLowerCase());
		if (fields.indexOf("*") !== -1 || vals.indexOf("*") !== -1) return "*";
		for (var i = 0; i < fields.length; i++) {
			var fld = fields[i].toLowerCase();
			if (vals.indexOf(fld) === -1) {
				vals.push(fld);
				val = val ? val + ", " + fields[i] : fields[i];
			}
		}
		return val;
	}
	/**
	* Parse a vary header into an array.
	*
	* @param {String} header
	* @return {Array}
	* @private
	*/
	function parse(header) {
		var end = 0;
		var list = [];
		var start = 0;
		for (var i = 0, len = header.length; i < len; i++) switch (header.charCodeAt(i)) {
			case 32:
				if (start === end) start = end = i + 1;
				break;
			case 44:
				list.push(header.substring(start, end));
				start = end = i + 1;
				break;
			default:
				end = i + 1;
				break;
		}
		list.push(header.substring(start, end));
		return list;
	}
	/**
	* Mark that a request is varied on a header field.
	*
	* @param {Object} res
	* @param {String|Array} field
	* @public
	*/
	function vary(res, field) {
		if (!res || !res.getHeader || !res.setHeader) throw new TypeError("res argument is required");
		var val = res.getHeader("Vary") || "";
		if (val = append(Array.isArray(val) ? val.join(", ") : String(val), field)) res.setHeader("Vary", val);
	}
}));
//#endregion
//#region node_modules/cors/lib/index.js
var require_lib$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function() {
		"use strict";
		var assign = require_object_assign();
		var vary = require_vary();
		var defaults = {
			origin: "*",
			methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
			preflightContinue: false,
			optionsSuccessStatus: 204
		};
		function isString(s) {
			return typeof s === "string" || s instanceof String;
		}
		function isOriginAllowed(origin, allowedOrigin) {
			if (Array.isArray(allowedOrigin)) {
				for (var i = 0; i < allowedOrigin.length; ++i) if (isOriginAllowed(origin, allowedOrigin[i])) return true;
				return false;
			} else if (isString(allowedOrigin)) return origin === allowedOrigin;
			else if (allowedOrigin instanceof RegExp) return allowedOrigin.test(origin);
			else return !!allowedOrigin;
		}
		function configureOrigin(options, req) {
			var requestOrigin = req.headers.origin, headers = [], isAllowed;
			if (!options.origin || options.origin === "*") headers.push([{
				key: "Access-Control-Allow-Origin",
				value: "*"
			}]);
			else if (isString(options.origin)) {
				headers.push([{
					key: "Access-Control-Allow-Origin",
					value: options.origin
				}]);
				headers.push([{
					key: "Vary",
					value: "Origin"
				}]);
			} else {
				isAllowed = isOriginAllowed(requestOrigin, options.origin);
				headers.push([{
					key: "Access-Control-Allow-Origin",
					value: isAllowed ? requestOrigin : false
				}]);
				headers.push([{
					key: "Vary",
					value: "Origin"
				}]);
			}
			return headers;
		}
		function configureMethods(options) {
			var methods = options.methods;
			if (methods.join) methods = options.methods.join(",");
			return {
				key: "Access-Control-Allow-Methods",
				value: methods
			};
		}
		function configureCredentials(options) {
			if (options.credentials === true) return {
				key: "Access-Control-Allow-Credentials",
				value: "true"
			};
			return null;
		}
		function configureAllowedHeaders(options, req) {
			var allowedHeaders = options.allowedHeaders || options.headers;
			var headers = [];
			if (!allowedHeaders) {
				allowedHeaders = req.headers["access-control-request-headers"];
				headers.push([{
					key: "Vary",
					value: "Access-Control-Request-Headers"
				}]);
			} else if (allowedHeaders.join) allowedHeaders = allowedHeaders.join(",");
			if (allowedHeaders && allowedHeaders.length) headers.push([{
				key: "Access-Control-Allow-Headers",
				value: allowedHeaders
			}]);
			return headers;
		}
		function configureExposedHeaders(options) {
			var headers = options.exposedHeaders;
			if (!headers) return null;
			else if (headers.join) headers = headers.join(",");
			if (headers && headers.length) return {
				key: "Access-Control-Expose-Headers",
				value: headers
			};
			return null;
		}
		function configureMaxAge(options) {
			var maxAge = (typeof options.maxAge === "number" || options.maxAge) && options.maxAge.toString();
			if (maxAge && maxAge.length) return {
				key: "Access-Control-Max-Age",
				value: maxAge
			};
			return null;
		}
		function applyHeaders(headers, res) {
			for (var i = 0, n = headers.length; i < n; i++) {
				var header = headers[i];
				if (header) {
					if (Array.isArray(header)) applyHeaders(header, res);
					else if (header.key === "Vary" && header.value) vary(res, header.value);
					else if (header.value) res.setHeader(header.key, header.value);
				}
			}
		}
		function cors(options, req, res, next) {
			var headers = [];
			if ((req.method && req.method.toUpperCase && req.method.toUpperCase()) === "OPTIONS") {
				headers.push(configureOrigin(options, req));
				headers.push(configureCredentials(options));
				headers.push(configureMethods(options));
				headers.push(configureAllowedHeaders(options, req));
				headers.push(configureMaxAge(options));
				headers.push(configureExposedHeaders(options));
				applyHeaders(headers, res);
				if (options.preflightContinue) next();
				else {
					res.statusCode = options.optionsSuccessStatus;
					res.setHeader("Content-Length", "0");
					res.end();
				}
			} else {
				headers.push(configureOrigin(options, req));
				headers.push(configureCredentials(options));
				headers.push(configureExposedHeaders(options));
				applyHeaders(headers, res);
				next();
			}
		}
		function middlewareWrapper(o) {
			var optionsCallback = null;
			if (typeof o === "function") optionsCallback = o;
			else optionsCallback = function(req, cb) {
				cb(null, o);
			};
			return function corsMiddleware(req, res, next) {
				optionsCallback(req, function(err, options) {
					if (err) next(err);
					else {
						var corsOptions = assign({}, defaults, options);
						var originCallback = null;
						if (corsOptions.origin && typeof corsOptions.origin === "function") originCallback = corsOptions.origin;
						else if (corsOptions.origin) originCallback = function(origin, cb) {
							cb(null, corsOptions.origin);
						};
						if (originCallback) originCallback(req.headers.origin, function(err2, origin) {
							if (err2 || !origin) next(err2);
							else {
								corsOptions.origin = origin;
								cors(corsOptions, req, res, next);
							}
						});
						else next();
					}
				});
			};
		}
		module.exports = middlewareWrapper;
	})();
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/http/express-adapter.js
var require_express_adapter = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExpressAdapter = void 0;
	const http_1$1 = __importDefault(__require("http"));
	const cors_1 = __importDefault(require_lib$1());
	const express_1$1 = __importDefault(__require("express"));
	const teams_common_1 = require_dist$3();
	/**
	* Express adapter for HttpServer
	*
	* Handles Express-specific HTTP framework concerns:
	* - Express app creation and middleware setup
	* - Route registration via Express routing
	* - Request/response data extraction and sending
	* - Server lifecycle management
	*/
	var ExpressAdapter = class {
		get;
		post;
		patch;
		put;
		delete;
		route;
		use;
		express;
		server;
		logger;
		onError;
		constructor(serverOrApp, options) {
			if (serverOrApp instanceof http_1$1.default.Server) {
				this.express = (0, express_1$1.default)();
				this.server = serverOrApp;
				this.server.on("request", this.express);
			} else if (typeof serverOrApp === "function") this.express = serverOrApp;
			else {
				this.express = (0, express_1$1.default)();
				this.server = http_1$1.default.createServer(this.express);
			}
			this.logger = options?.logger ?? new teams_common_1.ConsoleLogger("ExpressAdapter");
			this.onError = options?.onError;
			this.get = this.express.get.bind(this.express);
			this.post = this.express.post.bind(this.express);
			this.patch = this.express.patch.bind(this.express);
			this.put = this.express.put.bind(this.express);
			this.delete = this.express.delete.bind(this.express);
			this.route = this.express.route.bind(this.express);
			this.use = this.express.use.bind(this.express);
		}
		/**
		* Register a route handler for a given HTTP method and path
		*/
		registerRoute(method, path, handler) {
			if (method !== "POST") throw new Error(`Unsupported HTTP method: ${method}`);
			const expressHandler = async (req, res, next) => {
				try {
					const response = await handler({
						body: req.body,
						headers: req.headers
					});
					res.status(response.status).send(response.body);
				} catch (err) {
					next(err);
				}
			};
			this.express.post(path, express_1$1.default.json(), expressHandler);
		}
		/**
		* Start the server listening on the specified port
		*/
		async start(port) {
			const server = this.server;
			if (!server) throw new Error("Cannot start: server lifecycle is managed externally. Call listen() on your Express app or http.Server directly.");
			return new Promise((resolve, reject) => {
				server.once("error", (err) => {
					if (this.onError) this.onError(err);
					reject(err);
				});
				server.listen(port, () => {
					this.logger.info(`listening on port ${port} 🚀`);
					if (this.onError) server.on("error", this.onError);
					resolve();
				});
			});
		}
		/**
		* Serve static files from a directory
		*/
		serveStatic(path, directory) {
			this.express.use(path, (0, cors_1.default)(), express_1$1.default.static(directory));
		}
		/**
		* Stop the server and close all connections
		*/
		async stop() {
			const server = this.server;
			if (!server) throw new Error("Cannot stop: server lifecycle is managed externally. Call close() on your Express app or http.Server directly.");
			return new Promise((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else {
						this.logger.info("server stopped");
						resolve();
					}
				});
			});
		}
	};
	exports.ExpressAdapter = ExpressAdapter;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/http/index.js
var require_http$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExpressAdapter = void 0;
	var express_adapter_1 = require_express_adapter();
	Object.defineProperty(exports, "ExpressAdapter", {
		enumerable: true,
		get: function() {
			return express_adapter_1.ExpressAdapter;
		}
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/auth/service-token-validator.js
var require_service_token_validator = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ServiceTokenValidator = void 0;
	const teams_api_1 = require_dist$2();
	const jwt_validator_1 = require_jwt_validator();
	/**
	* Derives the JWKS keys URI from an OpenID metadata URL.
	* e.g. "https://login.botframework.com/v1/.well-known/openidconfiguration"
	*   -> "https://login.botframework.com/v1/.well-known/keys"
	*/
	function openIdMetadataToKeysUri(openIdMetadataUrl) {
		return openIdMetadataUrl.replace(/\/openidconfiguration$/, "/keys");
	}
	/**
	* Service token validator for Bot Framework /api/messages requests
	* Validates Bot Framework service tokens
	*/
	var ServiceTokenValidator = class {
		jwtValidator;
		credentials;
		constructor(appId, tenantId, serviceUrl, logger, cloud) {
			const env = cloud ?? teams_api_1.PUBLIC;
			this.jwtValidator = new jwt_validator_1.JwtValidator({
				clientId: appId,
				tenantId,
				loginEndpoint: env.loginEndpoint,
				validateIssuer: { allowedIssuer: env.tokenIssuer },
				validateServiceUrl: serviceUrl ? { expectedServiceUrl: serviceUrl } : void 0,
				jwksUriOptions: {
					type: "uri",
					uri: openIdMetadataToKeysUri(env.openIdMetadataUrl)
				}
			}, logger);
			this.credentials = {
				clientId: appId,
				tenantId
			};
		}
		async check(authHeader, body) {
			const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
			const payload = await this.jwtValidator.validateAccessToken(token, { validateServiceUrl: body.serviceUrl ? { expectedServiceUrl: body.serviceUrl } : void 0 });
			if (!payload) throw new Error("Invalid token");
			const serviceUrl = body.serviceUrl || payload.serviceurl || "";
			return {
				appId: payload.appid || this.credentials?.clientId || "",
				from: "azure",
				fromId: payload.sub || "",
				serviceUrl,
				isExpired: () => false
			};
		}
	};
	exports.ServiceTokenValidator = ServiceTokenValidator;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/http/http-server.js
var require_http_server = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HttpServer = void 0;
	const teams_common_1 = require_dist$3();
	const service_token_validator_1 = require_service_token_validator();
	/**
	* Configurable HTTP server for receiving Teams activities
	*/
	var HttpServer = class {
		/**
		* Callback invoked when a valid activity request arrives
		* App should set this to process activities
		*/
		onRequest;
		logger;
		credentials;
		skipAuth;
		cloud;
		initialized = false;
		serviceTokenValidator;
		_adapter;
		_messagingEndpoint;
		/**
		* Get the underlying adapter
		* Useful for plugins that need adapter-specific features
		*/
		get adapter() {
			return this._adapter;
		}
		/**
		* Get the messaging endpoint path
		*/
		get messagingEndpoint() {
			return this._messagingEndpoint;
		}
		constructor(adapter, options) {
			this._adapter = adapter;
			this.skipAuth = options.skipAuth ?? false;
			this.logger = options.logger ?? new teams_common_1.ConsoleLogger("HttpServer");
			this._messagingEndpoint = options.messagingEndpoint;
		}
		/**
		* Initialize the server with dependencies (registers routes, prepares adapter)
		* Can be called multiple times - only initializes once
		* Called by App.initialize()
		*/
		async initialize(deps) {
			if (this.initialized) {
				this.logger.debug("HttpServer already initialized, skipping");
				return;
			}
			this.credentials = deps.credentials;
			this.cloud = deps.cloud;
			if (this.credentials && !this.skipAuth) this.serviceTokenValidator = new service_token_validator_1.ServiceTokenValidator(this.credentials.clientId, this.credentials.tenantId, void 0, this.logger, deps.cloud);
			this._adapter.registerRoute("POST", this._messagingEndpoint, async (request) => {
				return this.handleRequest(request);
			});
			this.initialized = true;
		}
		/**
		* Start the HTTP server
		* Called by App.start()
		*/
		async start(port) {
			if (!this._adapter.start) throw new Error("Adapter does not implement start(). Either implement start() in your adapter, or manage server lifecycle manually.");
			await this._adapter.start(port);
		}
		/**
		* Stop the HTTP server
		* Called by App.stop() if implemented
		*/
		async stop() {
			if (!this._adapter.stop) {
				this.logger.warn("Adapter does not implement stop(). Skipping server shutdown.");
				return;
			}
			await this._adapter.stop();
		}
		/**
		* Register a route handler with the adapter
		* Used by app.function() and other app methods
		*/
		registerRoute(method, path, handler) {
			this._adapter.registerRoute(method, path, handler);
		}
		/**
		* Serve static files from a directory
		* Used by app.tab() and other app methods
		*/
		serveStatic(path, directory) {
			if (this._adapter.serveStatic) this._adapter.serveStatic(path, directory);
		}
		/**
		* Handle incoming activity request
		* Validates JWT, dispatches to app, returns response
		*/
		async handleRequest(request) {
			try {
				const body = request.body;
				this.logger.debug("Handling activity", body);
				const auth = await this.authorize(request.headers, body);
				if (!auth.success) return {
					status: 401,
					body: { error: auth.error }
				};
				if (!this.onRequest) throw new Error("HttpServer.onRequest callback not set");
				const response = await this.onRequest({
					body,
					token: auth.token
				});
				return {
					status: response.status || 200,
					body: response.body
				};
			} catch (err) {
				this.logger.error("Error processing activity:", err);
				return {
					status: 500,
					body: { error: "Internal server error" }
				};
			}
		}
		/**
		* Authorize the request by validating the JWT token.
		*/
		async authorize(headers, body) {
			if (this.skipAuth || !this.credentials) return {
				success: true,
				token: {
					appId: "",
					from: "azure",
					fromId: "",
					serviceUrl: body.serviceUrl || "",
					isExpired: () => false
				}
			};
			const raw = headers["authorization"];
			const authHeader = Array.isArray(raw) ? raw[0] : raw;
			if (!authHeader) return {
				success: false,
				error: "Missing authorization header"
			};
			if (!this.serviceTokenValidator) throw new Error("Service token validator not initialized - credentials required");
			try {
				return {
					success: true,
					token: await this.serviceTokenValidator.check(authHeader, body)
				};
			} catch (err) {
				this.logger.error("JWT validation failed", err);
				return {
					success: false,
					error: "JWT validation failed"
				};
			}
		}
	};
	exports.HttpServer = HttpServer;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/jwt-validation-middleware.js
var require_jwt_validation_middleware = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.withJwtValidation = withJwtValidation;
	const teams_common_1 = require_dist$3();
	const service_token_validator_1 = require_service_token_validator();
	function withJwtValidation(params) {
		const { credentials, logger: inputLogger, cloud } = params;
		const logger = inputLogger?.child("jwt-validation-middleware") ?? new teams_common_1.ConsoleLogger("jwt-validation-middleware");
		let validator;
		if (credentials?.clientId) validator = new service_token_validator_1.ServiceTokenValidator(credentials.clientId, credentials.tenantId, void 0, logger, cloud);
		else {
			logger.debug("No credentials provided, skipping service token validation");
			validator = null;
		}
		return async (req, res, next) => {
			if (!validator) {
				logger.debug("No service token validator configured, skipping validation");
				next();
				return;
			}
			const authHeader = req.headers.authorization;
			if (!authHeader) {
				res.status(401).send("unauthorized");
				return;
			}
			const activity = req.body;
			try {
				const token = await validator.check(authHeader, activity);
				logger.debug(`validated service token for activity ${activity.id}`);
				req.validatedToken = token;
				next();
			} catch (err) {
				logger.error("Token validation failed:", err);
				res.status(401).send("Invalid token");
			}
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/strip-mentions-text.js
var require_strip_mentions_text = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.stripMentionsText = stripMentionsText;
	const teams_api_1 = require_dist$2();
	function stripMentionsText(options) {
		return ({ activity, next }) => {
			if (activity.type === "message" || activity.type === "messageUpdate" || activity.type === "typing") activity.text = (0, teams_api_1.stripMentionsText)(activity, options);
			return next();
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/with-remote-function-jwt-validation.js
var require_with_remote_function_jwt_validation = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.withRemoteFunctionJwtValidation = withRemoteFunctionJwtValidation;
	const remote_function_validator_1 = require_remote_function_validator();
	/**
	* JWT validation middleware used to validate the entra token when remote functions are invoked.
	*/
	function withRemoteFunctionJwtValidation(params) {
		const entraTokenValidator = params.entraTokenValidator;
		const log = params.logger;
		const validator = entraTokenValidator ? new remote_function_validator_1.RemoteFunctionValidator(entraTokenValidator, log) : null;
		return async (req, res, next) => {
			if (!validator) {
				log.debug("unauthorized - no token validator configured");
				res.status(401).send("unauthorized");
				return;
			}
			const headers = {};
			Object.keys(req.headers).forEach((key) => {
				const value = req.headers[key];
				if (typeof value === "string") headers[key.toLowerCase()] = value;
			});
			const context = await validator.check(headers);
			if (!context) {
				res.status(401).send("unauthorized");
				return;
			}
			req.context = context;
			next();
		};
	}
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/middleware/index.js
var require_middleware = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$7) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$7, p)) __createBinding(exports$7, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ServiceTokenValidator = exports.RemoteFunctionValidator = exports.JwtValidator = exports.createEntraTokenValidator = void 0;
	var jwt_validator_1 = require_jwt_validator();
	Object.defineProperty(exports, "createEntraTokenValidator", {
		enumerable: true,
		get: function() {
			return jwt_validator_1.createEntraTokenValidator;
		}
	});
	Object.defineProperty(exports, "JwtValidator", {
		enumerable: true,
		get: function() {
			return jwt_validator_1.JwtValidator;
		}
	});
	var remote_function_validator_1 = require_remote_function_validator();
	Object.defineProperty(exports, "RemoteFunctionValidator", {
		enumerable: true,
		get: function() {
			return remote_function_validator_1.RemoteFunctionValidator;
		}
	});
	var service_token_validator_1 = require_service_token_validator();
	Object.defineProperty(exports, "ServiceTokenValidator", {
		enumerable: true,
		get: function() {
			return service_token_validator_1.ServiceTokenValidator;
		}
	});
	__exportStar(require_jwt_validation_middleware(), exports);
	__exportStar(require_strip_mentions_text(), exports);
	__exportStar(require_with_remote_function_jwt_validation(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/oauth.js
var require_oauth = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DEFAULT_OAUTH_SETTINGS = void 0;
	exports.DEFAULT_OAUTH_SETTINGS = { defaultConnectionName: "graph" };
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/activity.js
var require_activity = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/conversation-update.js
var require_conversation_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/event.js
var require_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EVENT_ALIASES = void 0;
	exports.EVENT_ALIASES = {
		"application/vnd.microsoft.readReceipt": "readReceipt",
		"application/vnd.microsoft.meetingStart": "meetingStart",
		"application/vnd.microsoft.meetingEnd": "meetingEnd",
		"application/vnd.microsoft.meetingParticipantJoin": "meetingParticipantJoin",
		"application/vnd.microsoft.meetingParticipantLeave": "meetingParticipantLeave"
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/install.js
var require_install = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/card-action.js
var require_card_action = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/dialog-open.js
var require_dialog_open = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/dialog-submit.js
var require_dialog_submit = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/file-consent.js
var require_file_consent = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/message-extension-submit.js
var require_message_extension_submit = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/message-submit.js
var require_message_submit = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/invoke/index.js
var require_invoke = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$6) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$6, p)) __createBinding(exports$6, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.INVOKE_ALIASES = void 0;
	exports.INVOKE_ALIASES = {
		"config/fetch": "config.open",
		"config/submit": "config.submit",
		"fileConsent/invoke": "file.consent",
		"actionableMessage/executeAction": "message.execute",
		"composeExtension/queryLink": "message.ext.query-link",
		"composeExtension/anonymousQueryLink": "message.ext.anon-query-link",
		"composeExtension/query": "message.ext.query",
		"composeExtension/selectItem": "message.ext.select-item",
		"composeExtension/submitAction": "message.ext.submit",
		"composeExtension/fetchTask": "message.ext.open",
		"composeExtension/querySettingUrl": "message.ext.query-settings-url",
		"composeExtension/setting": "message.ext.setting",
		"composeExtension/onCardButtonClicked": "message.ext.card-button-clicked",
		"task/fetch": "dialog.open",
		"task/submit": "dialog.submit",
		"tab/fetch": "tab.open",
		"tab/submit": "tab.submit",
		"message/fetchTask": "message.fetch-task",
		"message/submitAction": "message.submit",
		"handoff/action": "handoff.action",
		"signin/tokenExchange": "signin.token-exchange",
		"signin/verifyState": "signin.verify-state",
		"signin/failure": "signin.failure",
		"adaptiveCard/action": "card.action"
	};
	__exportStar(require_card_action(), exports);
	__exportStar(require_dialog_open(), exports);
	__exportStar(require_dialog_submit(), exports);
	__exportStar(require_file_consent(), exports);
	__exportStar(require_message_extension_submit(), exports);
	__exportStar(require_message_submit(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/message-delete.js
var require_message_delete = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/message-update.js
var require_message_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/routes/index.js
var require_routes = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$5) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$5, p)) __createBinding(exports$5, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_activity(), exports);
	__exportStar(require_conversation_update(), exports);
	__exportStar(require_event(), exports);
	__exportStar(require_install(), exports);
	__exportStar(require_invoke(), exports);
	__exportStar(require_message_delete(), exports);
	__exportStar(require_message_update(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/router/router.js
var require_router$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Router = void 0;
	const routes_1 = require_routes();
	var Router = class {
		routes = [];
		/**
		* select routes that match the inbound activity
		* @param activity the inbound activity
		*/
		select(activity) {
			return this.routes.filter((r) => r.select(activity)).map((r) => r.callback);
		}
		/**
		* register a new route
		* @param route the route to register
		*/
		register(route) {
			if (route.type === "user") {
				const i = this.routes.findIndex((r) => r.name === route.name && r.type === "system");
				if (i > -1) this.routes.splice(i, 1);
			}
			this.routes.push(route);
			return this;
		}
		/**
		* register a middleware
		* @param callback the callback to invoke
		*/
		use(callback, type) {
			this.register({
				type: type || "user",
				select: () => true,
				callback
			});
			return this;
		}
		/**
		* register an activity route
		* @param event event to subscribe to
		* @param callback the callback to invoke
		*/
		on(event, callback, type) {
			this.register({
				name: event,
				type: type || "user",
				select: (activity) => {
					if (event === "activity") return true;
					if (event === activity.type) return true;
					if (activity.type === "conversationUpdate") return event === activity.channelData?.eventType;
					if (activity.type === "installationUpdate") return event === `install.${activity.action}`;
					if (activity.type === "messageDelete") return event === activity.channelData?.eventType;
					if (activity.type === "messageUpdate") return event === activity.channelData?.eventType;
					if (activity.type === "event") return event === routes_1.EVENT_ALIASES[activity.name];
					if (activity.type === "invoke") {
						if (event === routes_1.INVOKE_ALIASES[activity.name]) return true;
						if (activity.name === "fileConsent/invoke") return event === `file.consent.${activity.value.action}`;
						if (activity.name === "composeExtension/submitAction") return event === `message.ext.${activity.value.botMessagePreviewAction}`;
						if (activity.name === "message/submitAction") return event === `message.submit.${activity.value.actionName}`;
						if (activity.name === "task/fetch" && activity.value?.data?.dialog_id) return event === `dialog.open.${activity.value.data.dialog_id}`;
						if (activity.name === "task/submit" && activity.value?.data?.action) return event === `dialog.submit.${activity.value.data.action}`;
						if (activity.name === "adaptiveCard/action" && activity.value?.action?.data?.action) return event === `card.action.${activity.value.action.data.action}`;
					}
					if (event === "mention" && activity.entities?.some((e) => e.type === "mention")) return activity.entities?.find((e) => e.type === "mention" && e.mentioned.id === activity.recipient.id) !== void 0;
					return false;
				},
				callback
			});
			return this;
		}
	};
	exports.Router = Router;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/router/index.js
var require_router = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$4) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$4, p)) __createBinding(exports$4, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_router$1(), exports);
}));
//#endregion
//#region node_modules/uuid/dist-node/max.js
var max_default;
var init_max = __esmMin((() => {
	max_default = "ffffffff-ffff-ffff-ffff-ffffffffffff";
}));
//#endregion
//#region node_modules/uuid/dist-node/nil.js
var nil_default;
var init_nil = __esmMin((() => {
	nil_default = "00000000-0000-0000-0000-000000000000";
}));
//#endregion
//#region node_modules/uuid/dist-node/regex.js
var regex_default;
var init_regex = __esmMin((() => {
	regex_default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
}));
//#endregion
//#region node_modules/uuid/dist-node/validate.js
function validate(uuid) {
	return typeof uuid === "string" && regex_default.test(uuid);
}
var init_validate = __esmMin((() => {
	init_regex();
}));
//#endregion
//#region node_modules/uuid/dist-node/parse.js
function parse(uuid) {
	if (!validate(uuid)) throw TypeError("Invalid UUID");
	let v;
	return Uint8Array.of((v = parseInt(uuid.slice(0, 8), 16)) >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255, (v = parseInt(uuid.slice(9, 13), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(14, 18), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(19, 23), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(24, 36), 16)) / 1099511627776 & 255, v / 4294967296 & 255, v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
}
var init_parse = __esmMin((() => {
	init_validate();
}));
//#endregion
//#region node_modules/uuid/dist-node/stringify.js
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!validate(uuid)) throw TypeError("Stringified UUID is invalid");
	return uuid;
}
var byteToHex;
var init_stringify = __esmMin((() => {
	init_validate();
	byteToHex = [];
	for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
}));
//#endregion
//#region node_modules/uuid/dist-node/rng.js
function rng() {
	return crypto.getRandomValues(rnds8);
}
var rnds8;
var init_rng = __esmMin((() => {
	rnds8 = new Uint8Array(16);
}));
//#endregion
//#region node_modules/uuid/dist-node/v1.js
function v1(options, buf, offset) {
	let bytes;
	const isV6 = options?._v6 ?? false;
	if (options) {
		const optionsKeys = Object.keys(options);
		if (optionsKeys.length === 1 && optionsKeys[0] === "_v6") options = void 0;
	}
	if (options) bytes = v1Bytes(options.random ?? options.rng?.() ?? rng(), options.msecs, options.nsecs, options.clockseq, options.node, buf, offset);
	else {
		const now = Date.now();
		const rnds = rng();
		updateV1State(_state$1, now, rnds);
		bytes = v1Bytes(rnds, _state$1.msecs, _state$1.nsecs, isV6 ? void 0 : _state$1.clockseq, isV6 ? void 0 : _state$1.node, buf, offset);
	}
	return buf ?? unsafeStringify(bytes);
}
function updateV1State(state, now, rnds) {
	state.msecs ??= -Infinity;
	state.nsecs ??= 0;
	if (now === state.msecs) {
		state.nsecs++;
		if (state.nsecs >= 1e4) {
			state.node = void 0;
			state.nsecs = 0;
		}
	} else if (now > state.msecs) state.nsecs = 0;
	else if (now < state.msecs) state.node = void 0;
	if (!state.node) {
		state.node = rnds.slice(10, 16);
		state.node[0] |= 1;
		state.clockseq = (rnds[8] << 8 | rnds[9]) & 16383;
	}
	state.msecs = now;
	return state;
}
function v1Bytes(rnds, msecs, nsecs, clockseq, node, buf, offset = 0) {
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	if (!buf) {
		buf = new Uint8Array(16);
		offset = 0;
	} else if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
	msecs ??= Date.now();
	nsecs ??= 0;
	clockseq ??= (rnds[8] << 8 | rnds[9]) & 16383;
	node ??= rnds.slice(10, 16);
	msecs += 0xb1d069b5400;
	const tl = ((msecs & 268435455) * 1e4 + nsecs) % 4294967296;
	buf[offset++] = tl >>> 24 & 255;
	buf[offset++] = tl >>> 16 & 255;
	buf[offset++] = tl >>> 8 & 255;
	buf[offset++] = tl & 255;
	const tmh = msecs / 4294967296 * 1e4 & 268435455;
	buf[offset++] = tmh >>> 8 & 255;
	buf[offset++] = tmh & 255;
	buf[offset++] = tmh >>> 24 & 15 | 16;
	buf[offset++] = tmh >>> 16 & 255;
	buf[offset++] = clockseq >>> 8 | 128;
	buf[offset++] = clockseq & 255;
	for (let n = 0; n < 6; ++n) buf[offset++] = node[n];
	return buf;
}
var _state$1;
var init_v1 = __esmMin((() => {
	init_rng();
	init_stringify();
	_state$1 = {};
}));
//#endregion
//#region node_modules/uuid/dist-node/v1ToV6.js
function v1ToV6(uuid) {
	const v6Bytes = _v1ToV6(typeof uuid === "string" ? parse(uuid) : uuid);
	return typeof uuid === "string" ? unsafeStringify(v6Bytes) : v6Bytes;
}
function _v1ToV6(v1Bytes) {
	return Uint8Array.of((v1Bytes[6] & 15) << 4 | v1Bytes[7] >> 4 & 15, (v1Bytes[7] & 15) << 4 | (v1Bytes[4] & 240) >> 4, (v1Bytes[4] & 15) << 4 | (v1Bytes[5] & 240) >> 4, (v1Bytes[5] & 15) << 4 | (v1Bytes[0] & 240) >> 4, (v1Bytes[0] & 15) << 4 | (v1Bytes[1] & 240) >> 4, (v1Bytes[1] & 15) << 4 | (v1Bytes[2] & 240) >> 4, 96 | v1Bytes[2] & 15, v1Bytes[3], v1Bytes[8], v1Bytes[9], v1Bytes[10], v1Bytes[11], v1Bytes[12], v1Bytes[13], v1Bytes[14], v1Bytes[15]);
}
var init_v1ToV6 = __esmMin((() => {
	init_parse();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/md5.js
function md5(bytes) {
	if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
	else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
	return createHash("md5").update(bytes).digest();
}
var init_md5 = __esmMin((() => {}));
//#endregion
//#region node_modules/uuid/dist-node/v35.js
function stringToBytes(str) {
	str = unescape(encodeURIComponent(str));
	const bytes = new Uint8Array(str.length);
	for (let i = 0; i < str.length; ++i) bytes[i] = str.charCodeAt(i);
	return bytes;
}
function v35(version, hash, value, namespace, buf, offset) {
	const valueBytes = typeof value === "string" ? stringToBytes(value) : value;
	const namespaceBytes = typeof namespace === "string" ? parse(namespace) : namespace;
	if (typeof namespace === "string") namespace = parse(namespace);
	if (namespace?.length !== 16) throw TypeError("Namespace must be array-like (16 iterable integer values, 0-255)");
	let bytes = new Uint8Array(16 + valueBytes.length);
	bytes.set(namespaceBytes);
	bytes.set(valueBytes, namespaceBytes.length);
	bytes = hash(bytes);
	bytes[6] = bytes[6] & 15 | version;
	bytes[8] = bytes[8] & 63 | 128;
	if (buf) {
		offset ??= 0;
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; ++i) buf[offset + i] = bytes[i];
		return buf;
	}
	return unsafeStringify(bytes);
}
var DNS, URL$1;
var init_v35 = __esmMin((() => {
	init_parse();
	init_stringify();
	DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
	URL$1 = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
}));
//#endregion
//#region node_modules/uuid/dist-node/v3.js
function v3(value, namespace, buf, offset) {
	return v35(48, md5, value, namespace, buf, offset);
}
var init_v3 = __esmMin((() => {
	init_md5();
	init_v35();
	v3.DNS = DNS;
	v3.URL = URL$1;
}));
//#endregion
//#region node_modules/uuid/dist-node/v4.js
function v4(options, buf, offset) {
	if (!buf && !options && crypto.randomUUID) return crypto.randomUUID();
	return _v4(options, buf, offset);
}
function _v4(options, buf, offset) {
	options = options || {};
	const rnds = options.random ?? options.rng?.() ?? rng();
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	rnds[6] = rnds[6] & 15 | 64;
	rnds[8] = rnds[8] & 63 | 128;
	if (buf) {
		offset = offset || 0;
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; ++i) buf[offset + i] = rnds[i];
		return buf;
	}
	return unsafeStringify(rnds);
}
var init_v4 = __esmMin((() => {
	init_rng();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/sha1.js
function sha1(bytes) {
	if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
	else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
	return createHash("sha1").update(bytes).digest();
}
var init_sha1 = __esmMin((() => {}));
//#endregion
//#region node_modules/uuid/dist-node/v5.js
function v5(value, namespace, buf, offset) {
	return v35(80, sha1, value, namespace, buf, offset);
}
var init_v5 = __esmMin((() => {
	init_sha1();
	init_v35();
	v5.DNS = DNS;
	v5.URL = URL$1;
}));
//#endregion
//#region node_modules/uuid/dist-node/v6.js
function v6(options, buf, offset) {
	options ??= {};
	offset ??= 0;
	let bytes = v1({
		...options,
		_v6: true
	}, new Uint8Array(16));
	bytes = v1ToV6(bytes);
	if (buf) {
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; i++) buf[offset + i] = bytes[i];
		return buf;
	}
	return unsafeStringify(bytes);
}
var init_v6 = __esmMin((() => {
	init_stringify();
	init_v1();
	init_v1ToV6();
}));
//#endregion
//#region node_modules/uuid/dist-node/v6ToV1.js
function v6ToV1(uuid) {
	const v1Bytes = _v6ToV1(typeof uuid === "string" ? parse(uuid) : uuid);
	return typeof uuid === "string" ? unsafeStringify(v1Bytes) : v1Bytes;
}
function _v6ToV1(v6Bytes) {
	return Uint8Array.of((v6Bytes[3] & 15) << 4 | v6Bytes[4] >> 4 & 15, (v6Bytes[4] & 15) << 4 | (v6Bytes[5] & 240) >> 4, (v6Bytes[5] & 15) << 4 | v6Bytes[6] & 15, v6Bytes[7], (v6Bytes[1] & 15) << 4 | (v6Bytes[2] & 240) >> 4, (v6Bytes[2] & 15) << 4 | (v6Bytes[3] & 240) >> 4, 16 | (v6Bytes[0] & 240) >> 4, (v6Bytes[0] & 15) << 4 | (v6Bytes[1] & 240) >> 4, v6Bytes[8], v6Bytes[9], v6Bytes[10], v6Bytes[11], v6Bytes[12], v6Bytes[13], v6Bytes[14], v6Bytes[15]);
}
var init_v6ToV1 = __esmMin((() => {
	init_parse();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/v7.js
function v7(options, buf, offset) {
	let bytes;
	if (options) bytes = v7Bytes(options.random ?? options.rng?.() ?? rng(), options.msecs, options.seq, buf, offset);
	else {
		const now = Date.now();
		const rnds = rng();
		updateV7State(_state, now, rnds);
		bytes = v7Bytes(rnds, _state.msecs, _state.seq, buf, offset);
	}
	return buf ?? unsafeStringify(bytes);
}
function updateV7State(state, now, rnds) {
	state.msecs ??= -Infinity;
	state.seq ??= 0;
	if (now > state.msecs) {
		state.seq = rnds[6] << 23 | rnds[7] << 16 | rnds[8] << 8 | rnds[9];
		state.msecs = now;
	} else {
		state.seq = state.seq + 1 | 0;
		if (state.seq === 0) state.msecs++;
	}
	return state;
}
function v7Bytes(rnds, msecs, seq, buf, offset = 0) {
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	if (!buf) {
		buf = new Uint8Array(16);
		offset = 0;
	} else if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
	msecs ??= Date.now();
	seq ??= rnds[6] * 127 << 24 | rnds[7] << 16 | rnds[8] << 8 | rnds[9];
	buf[offset++] = msecs / 1099511627776 & 255;
	buf[offset++] = msecs / 4294967296 & 255;
	buf[offset++] = msecs / 16777216 & 255;
	buf[offset++] = msecs / 65536 & 255;
	buf[offset++] = msecs / 256 & 255;
	buf[offset++] = msecs & 255;
	buf[offset++] = 112 | seq >>> 28 & 15;
	buf[offset++] = seq >>> 20 & 255;
	buf[offset++] = 128 | seq >>> 14 & 63;
	buf[offset++] = seq >>> 6 & 255;
	buf[offset++] = seq << 2 & 255 | rnds[10] & 3;
	buf[offset++] = rnds[11];
	buf[offset++] = rnds[12];
	buf[offset++] = rnds[13];
	buf[offset++] = rnds[14];
	buf[offset++] = rnds[15];
	return buf;
}
var _state;
var init_v7 = __esmMin((() => {
	init_rng();
	init_stringify();
	_state = {};
}));
//#endregion
//#region node_modules/uuid/dist-node/version.js
function version(uuid) {
	if (!validate(uuid)) throw TypeError("Invalid UUID");
	return parseInt(uuid.slice(14, 15), 16);
}
var init_version = __esmMin((() => {
	init_validate();
}));
//#endregion
//#region node_modules/uuid/dist-node/index.js
var dist_node_exports = /* @__PURE__ */ __exportAll({
	MAX: () => max_default,
	NIL: () => nil_default,
	parse: () => parse,
	stringify: () => stringify,
	v1: () => v1,
	v1ToV6: () => v1ToV6,
	v3: () => v3,
	v4: () => v4,
	v5: () => v5,
	v6: () => v6,
	v6ToV1: () => v6ToV1,
	v7: () => v7,
	validate: () => validate,
	version: () => version
});
var init_dist_node = __esmMin((() => {
	init_max();
	init_nil();
	init_parse();
	init_stringify();
	init_v1();
	init_v1ToV6();
	init_v3();
	init_v4();
	init_v5();
	init_v6();
	init_v6ToV1();
	init_v7();
	init_validate();
	init_version();
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/node_modules/@azure/msal-common/lib/index-node-Ddjhj5ij.js
/*! @azure/msal-common v15.17.0 2026-03-18 */
var require_index_node_Ddjhj5ij = /* @__PURE__ */ __commonJSMin(((exports) => {
	const Constants = {
		LIBRARY_NAME: "MSAL.JS",
		SKU: "msal.js.common",
		DEFAULT_AUTHORITY: "https://login.microsoftonline.com/common/",
		DEFAULT_AUTHORITY_HOST: "login.microsoftonline.com",
		DEFAULT_COMMON_TENANT: "common",
		ADFS: "adfs",
		DSTS: "dstsv2",
		AAD_INSTANCE_DISCOVERY_ENDPT: "https://login.microsoftonline.com/common/discovery/instance?api-version=1.1&authorization_endpoint=",
		CIAM_AUTH_URL: ".ciamlogin.com",
		AAD_TENANT_DOMAIN_SUFFIX: ".onmicrosoft.com",
		RESOURCE_DELIM: "|",
		NO_ACCOUNT: "NO_ACCOUNT",
		CLAIMS: "claims",
		CONSUMER_UTID: "9188040d-6c67-4c5b-b112-36a304b66dad",
		OPENID_SCOPE: "openid",
		PROFILE_SCOPE: "profile",
		OFFLINE_ACCESS_SCOPE: "offline_access",
		EMAIL_SCOPE: "email",
		CODE_GRANT_TYPE: "authorization_code",
		RT_GRANT_TYPE: "refresh_token",
		S256_CODE_CHALLENGE_METHOD: "S256",
		URL_FORM_CONTENT_TYPE: "application/x-www-form-urlencoded;charset=utf-8",
		AUTHORIZATION_PENDING: "authorization_pending",
		NOT_DEFINED: "not_defined",
		EMPTY_STRING: "",
		NOT_APPLICABLE: "N/A",
		NOT_AVAILABLE: "Not Available",
		FORWARD_SLASH: "/",
		IMDS_ENDPOINT: "http://169.254.169.254/metadata/instance/compute/location",
		IMDS_VERSION: "2020-06-01",
		IMDS_TIMEOUT: 2e3,
		AZURE_REGION_AUTO_DISCOVER_FLAG: "TryAutoDetect",
		REGIONAL_AUTH_PUBLIC_CLOUD_SUFFIX: "login.microsoft.com",
		KNOWN_PUBLIC_CLOUDS: [
			"login.microsoftonline.com",
			"login.windows.net",
			"login.microsoft.com",
			"sts.windows.net"
		],
		SHR_NONCE_VALIDITY: 240,
		INVALID_INSTANCE: "invalid_instance"
	};
	const HttpStatus = {
		SUCCESS: 200,
		SUCCESS_RANGE_START: 200,
		SUCCESS_RANGE_END: 299,
		REDIRECT: 302,
		CLIENT_ERROR: 400,
		CLIENT_ERROR_RANGE_START: 400,
		BAD_REQUEST: 400,
		UNAUTHORIZED: 401,
		NOT_FOUND: 404,
		REQUEST_TIMEOUT: 408,
		GONE: 410,
		TOO_MANY_REQUESTS: 429,
		CLIENT_ERROR_RANGE_END: 499,
		SERVER_ERROR: 500,
		SERVER_ERROR_RANGE_START: 500,
		SERVICE_UNAVAILABLE: 503,
		GATEWAY_TIMEOUT: 504,
		SERVER_ERROR_RANGE_END: 599,
		MULTI_SIDED_ERROR: 600
	};
	const HttpMethod = {
		GET: "GET",
		POST: "POST"
	};
	const OIDC_DEFAULT_SCOPES = [
		Constants.OPENID_SCOPE,
		Constants.PROFILE_SCOPE,
		Constants.OFFLINE_ACCESS_SCOPE
	];
	const OIDC_SCOPES = [...OIDC_DEFAULT_SCOPES, Constants.EMAIL_SCOPE];
	/**
	* Request header names
	*/
	const HeaderNames = {
		CONTENT_TYPE: "Content-Type",
		CONTENT_LENGTH: "Content-Length",
		RETRY_AFTER: "Retry-After",
		CCS_HEADER: "X-AnchorMailbox",
		WWWAuthenticate: "WWW-Authenticate",
		AuthenticationInfo: "Authentication-Info",
		X_MS_REQUEST_ID: "x-ms-request-id",
		X_MS_HTTP_VERSION: "x-ms-httpver"
	};
	/**
	* Persistent cache keys MSAL which stay while user is logged in.
	*/
	const PersistentCacheKeys = { ACTIVE_ACCOUNT_FILTERS: "active-account-filters" };
	/**
	* String constants related to AAD Authority
	*/
	const AADAuthorityConstants = {
		COMMON: "common",
		ORGANIZATIONS: "organizations",
		CONSUMERS: "consumers"
	};
	/**
	* Claims request keys
	*/
	const ClaimsRequestKeys = {
		ACCESS_TOKEN: "access_token",
		XMS_CC: "xms_cc"
	};
	/**
	* we considered making this "enum" in the request instead of string, however it looks like the allowed list of
	* prompt values kept changing over past couple of years. There are some undocumented prompt values for some
	* internal partners too, hence the choice of generic "string" type instead of the "enum"
	*/
	const PromptValue = {
		LOGIN: "login",
		SELECT_ACCOUNT: "select_account",
		CONSENT: "consent",
		NONE: "none",
		CREATE: "create",
		NO_SESSION: "no_session"
	};
	/**
	* allowed values for codeVerifier
	*/
	const CodeChallengeMethodValues = {
		PLAIN: "plain",
		S256: "S256"
	};
	/**
	* Allowed values for response_type
	*/
	const OAuthResponseType = {
		CODE: "code",
		IDTOKEN_TOKEN: "id_token token",
		IDTOKEN_TOKEN_REFRESHTOKEN: "id_token token refresh_token"
	};
	/**
	* allowed values for server response type
	* @deprecated Use ResponseMode instead
	*/
	const ServerResponseType = {
		QUERY: "query",
		FRAGMENT: "fragment"
	};
	/**
	* allowed values for response_mode
	*/
	const ResponseMode = {
		QUERY: "query",
		FRAGMENT: "fragment",
		FORM_POST: "form_post"
	};
	/**
	* allowed grant_type
	*/
	const GrantType = {
		IMPLICIT_GRANT: "implicit",
		AUTHORIZATION_CODE_GRANT: "authorization_code",
		CLIENT_CREDENTIALS_GRANT: "client_credentials",
		RESOURCE_OWNER_PASSWORD_GRANT: "password",
		REFRESH_TOKEN_GRANT: "refresh_token",
		DEVICE_CODE_GRANT: "device_code",
		JWT_BEARER: "urn:ietf:params:oauth:grant-type:jwt-bearer"
	};
	/**
	* Account types in Cache
	*/
	const CacheAccountType = {
		MSSTS_ACCOUNT_TYPE: "MSSTS",
		ADFS_ACCOUNT_TYPE: "ADFS",
		MSAV1_ACCOUNT_TYPE: "MSA",
		GENERIC_ACCOUNT_TYPE: "Generic"
	};
	/**
	* Separators used in cache
	*/
	const Separators = {
		CACHE_KEY_SEPARATOR: "-",
		CLIENT_INFO_SEPARATOR: "."
	};
	/**
	* Credential Type stored in the cache
	*/
	const CredentialType = {
		ID_TOKEN: "IdToken",
		ACCESS_TOKEN: "AccessToken",
		ACCESS_TOKEN_WITH_AUTH_SCHEME: "AccessToken_With_AuthScheme",
		REFRESH_TOKEN: "RefreshToken"
	};
	/**
	* Combine all cache types
	*/
	const CacheType = {
		ADFS: 1001,
		MSA: 1002,
		MSSTS: 1003,
		GENERIC: 1004,
		ACCESS_TOKEN: 2001,
		REFRESH_TOKEN: 2002,
		ID_TOKEN: 2003,
		APP_METADATA: 3001,
		UNDEFINED: 9999
	};
	/**
	* More Cache related constants
	*/
	const APP_METADATA = "appmetadata";
	const CLIENT_INFO$1 = "client_info";
	const THE_FAMILY_ID = "1";
	const AUTHORITY_METADATA_CONSTANTS = {
		CACHE_KEY: "authority-metadata",
		REFRESH_TIME_SECONDS: 3600 * 24
	};
	const AuthorityMetadataSource = {
		CONFIG: "config",
		CACHE: "cache",
		NETWORK: "network",
		HARDCODED_VALUES: "hardcoded_values"
	};
	const SERVER_TELEM_CONSTANTS = {
		SCHEMA_VERSION: 5,
		MAX_LAST_HEADER_BYTES: 330,
		MAX_CACHED_ERRORS: 50,
		CACHE_KEY: "server-telemetry",
		CATEGORY_SEPARATOR: "|",
		VALUE_SEPARATOR: ",",
		OVERFLOW_TRUE: "1",
		OVERFLOW_FALSE: "0",
		UNKNOWN_ERROR: "unknown_error"
	};
	/**
	* Type of the authentication request
	*/
	const AuthenticationScheme = {
		BEARER: "Bearer",
		POP: "pop",
		SSH: "ssh-cert"
	};
	/**
	* Constants related to throttling
	*/
	const ThrottlingConstants = {
		DEFAULT_THROTTLE_TIME_SECONDS: 60,
		DEFAULT_MAX_THROTTLE_TIME_SECONDS: 3600,
		THROTTLING_PREFIX: "throttling",
		X_MS_LIB_CAPABILITY_VALUE: "retry-after, h429"
	};
	const Errors = {
		INVALID_GRANT_ERROR: "invalid_grant",
		CLIENT_MISMATCH_ERROR: "client_mismatch"
	};
	/**
	* Password grant parameters
	*/
	const PasswordGrantConstants = {
		username: "username",
		password: "password"
	};
	/**
	* Region Discovery Sources
	*/
	const RegionDiscoverySources = {
		FAILED_AUTO_DETECTION: "1",
		INTERNAL_CACHE: "2",
		ENVIRONMENT_VARIABLE: "3",
		IMDS: "4"
	};
	/**
	* Region Discovery Outcomes
	*/
	const RegionDiscoveryOutcomes = {
		CONFIGURED_NO_AUTO_DETECTION: "2",
		AUTO_DETECTION_REQUESTED_SUCCESSFUL: "4",
		AUTO_DETECTION_REQUESTED_FAILED: "5"
	};
	/**
	* Specifies the reason for fetching the access token from the identity provider
	*/
	const CacheOutcome = {
		NOT_APPLICABLE: "0",
		FORCE_REFRESH_OR_CLAIMS: "1",
		NO_CACHED_ACCESS_TOKEN: "2",
		CACHED_ACCESS_TOKEN_EXPIRED: "3",
		PROACTIVELY_REFRESHED: "4"
	};
	const JsonWebTokenTypes = {
		Jwt: "JWT",
		Jwk: "JWK",
		Pop: "pop"
	};
	const ONE_DAY_IN_MS = 864e5;
	const DEFAULT_TOKEN_RENEWAL_OFFSET_SEC = 300;
	const EncodingTypes = {
		BASE64: "base64",
		HEX: "hex",
		UTF8: "utf-8"
	};
	/**
	* AuthErrorMessage class containing string constants used by error codes and messages.
	*/
	const unexpectedError = "unexpected_error";
	const postRequestFailed = "post_request_failed";
	var AuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		postRequestFailed,
		unexpectedError
	});
	const AuthErrorMessages = {
		[unexpectedError]: "Unexpected error in authentication.",
		[postRequestFailed]: "Post request failed from the network, could be a 4xx/5xx or a network unavailability. Please check the exact error code for details."
	};
	/**
	* AuthErrorMessage class containing string constants used by error codes and messages.
	* @deprecated Use AuthErrorCodes instead
	*/
	const AuthErrorMessage = {
		unexpectedError: {
			code: unexpectedError,
			desc: AuthErrorMessages[unexpectedError]
		},
		postRequestFailed: {
			code: postRequestFailed,
			desc: AuthErrorMessages[postRequestFailed]
		}
	};
	/**
	* General error class thrown by the MSAL.js library.
	*/
	var AuthError = class AuthError extends Error {
		constructor(errorCode, errorMessage, suberror) {
			const errorString = errorMessage ? `${errorCode}: ${errorMessage}` : errorCode;
			super(errorString);
			Object.setPrototypeOf(this, AuthError.prototype);
			this.errorCode = errorCode || Constants.EMPTY_STRING;
			this.errorMessage = errorMessage || Constants.EMPTY_STRING;
			this.subError = suberror || Constants.EMPTY_STRING;
			this.name = "AuthError";
		}
		setCorrelationId(correlationId) {
			this.correlationId = correlationId;
		}
	};
	function createAuthError(code, additionalMessage) {
		return new AuthError(code, additionalMessage ? `${AuthErrorMessages[code]} ${additionalMessage}` : AuthErrorMessages[code]);
	}
	const clientInfoDecodingError = "client_info_decoding_error";
	const clientInfoEmptyError = "client_info_empty_error";
	const tokenParsingError = "token_parsing_error";
	const nullOrEmptyToken = "null_or_empty_token";
	const endpointResolutionError = "endpoints_resolution_error";
	const networkError = "network_error";
	const openIdConfigError = "openid_config_error";
	const hashNotDeserialized = "hash_not_deserialized";
	const invalidState = "invalid_state";
	const stateMismatch = "state_mismatch";
	const stateNotFound = "state_not_found";
	const nonceMismatch = "nonce_mismatch";
	const authTimeNotFound = "auth_time_not_found";
	const maxAgeTranspired = "max_age_transpired";
	const multipleMatchingTokens = "multiple_matching_tokens";
	const multipleMatchingAccounts = "multiple_matching_accounts";
	const multipleMatchingAppMetadata = "multiple_matching_appMetadata";
	const requestCannotBeMade = "request_cannot_be_made";
	const cannotRemoveEmptyScope = "cannot_remove_empty_scope";
	const cannotAppendScopeSet = "cannot_append_scopeset";
	const emptyInputScopeSet = "empty_input_scopeset";
	const deviceCodePollingCancelled = "device_code_polling_cancelled";
	const deviceCodeExpired = "device_code_expired";
	const deviceCodeUnknownError = "device_code_unknown_error";
	const noAccountInSilentRequest = "no_account_in_silent_request";
	const invalidCacheRecord = "invalid_cache_record";
	const invalidCacheEnvironment = "invalid_cache_environment";
	const noAccountFound = "no_account_found";
	const noCryptoObject = "no_crypto_object";
	const unexpectedCredentialType = "unexpected_credential_type";
	const invalidAssertion = "invalid_assertion";
	const invalidClientCredential = "invalid_client_credential";
	const tokenRefreshRequired = "token_refresh_required";
	const userTimeoutReached = "user_timeout_reached";
	const tokenClaimsCnfRequiredForSignedJwt = "token_claims_cnf_required_for_signedjwt";
	const authorizationCodeMissingFromServerResponse = "authorization_code_missing_from_server_response";
	const bindingKeyNotRemoved = "binding_key_not_removed";
	const endSessionEndpointNotSupported = "end_session_endpoint_not_supported";
	const keyIdMissing = "key_id_missing";
	const noNetworkConnectivity = "no_network_connectivity";
	const userCanceled = "user_canceled";
	const missingTenantIdError = "missing_tenant_id_error";
	const methodNotImplemented = "method_not_implemented";
	const nestedAppAuthBridgeDisabled = "nested_app_auth_bridge_disabled";
	const platformBrokerError = "platform_broker_error";
	var ClientAuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		authTimeNotFound,
		authorizationCodeMissingFromServerResponse,
		bindingKeyNotRemoved,
		cannotAppendScopeSet,
		cannotRemoveEmptyScope,
		clientInfoDecodingError,
		clientInfoEmptyError,
		deviceCodeExpired,
		deviceCodePollingCancelled,
		deviceCodeUnknownError,
		emptyInputScopeSet,
		endSessionEndpointNotSupported,
		endpointResolutionError,
		hashNotDeserialized,
		invalidAssertion,
		invalidCacheEnvironment,
		invalidCacheRecord,
		invalidClientCredential,
		invalidState,
		keyIdMissing,
		maxAgeTranspired,
		methodNotImplemented,
		missingTenantIdError,
		multipleMatchingAccounts,
		multipleMatchingAppMetadata,
		multipleMatchingTokens,
		nestedAppAuthBridgeDisabled,
		networkError,
		noAccountFound,
		noAccountInSilentRequest,
		noCryptoObject,
		noNetworkConnectivity,
		nonceMismatch,
		nullOrEmptyToken,
		openIdConfigError,
		platformBrokerError,
		requestCannotBeMade,
		stateMismatch,
		stateNotFound,
		tokenClaimsCnfRequiredForSignedJwt,
		tokenParsingError,
		tokenRefreshRequired,
		unexpectedCredentialType,
		userCanceled,
		userTimeoutReached
	});
	/**
	* ClientAuthErrorMessage class containing string constants used by error codes and messages.
	*/
	const ClientAuthErrorMessages = {
		[clientInfoDecodingError]: "The client info could not be parsed/decoded correctly",
		[clientInfoEmptyError]: "The client info was empty",
		[tokenParsingError]: "Token cannot be parsed",
		[nullOrEmptyToken]: "The token is null or empty",
		[endpointResolutionError]: "Endpoints cannot be resolved",
		[networkError]: "Network request failed",
		[openIdConfigError]: "Could not retrieve endpoints. Check your authority and verify the .well-known/openid-configuration endpoint returns the required endpoints.",
		[hashNotDeserialized]: "The hash parameters could not be deserialized",
		[invalidState]: "State was not the expected format",
		[stateMismatch]: "State mismatch error",
		[stateNotFound]: "State not found",
		[nonceMismatch]: "Nonce mismatch error",
		[authTimeNotFound]: "Max Age was requested and the ID token is missing the auth_time variable. auth_time is an optional claim and is not enabled by default - it must be enabled. See https://aka.ms/msaljs/optional-claims for more information.",
		[maxAgeTranspired]: "Max Age is set to 0, or too much time has elapsed since the last end-user authentication.",
		[multipleMatchingTokens]: "The cache contains multiple tokens satisfying the requirements. Call AcquireToken again providing more requirements such as authority or account.",
		[multipleMatchingAccounts]: "The cache contains multiple accounts satisfying the given parameters. Please pass more info to obtain the correct account",
		[multipleMatchingAppMetadata]: "The cache contains multiple appMetadata satisfying the given parameters. Please pass more info to obtain the correct appMetadata",
		[requestCannotBeMade]: "Token request cannot be made without authorization code or refresh token.",
		[cannotRemoveEmptyScope]: "Cannot remove null or empty scope from ScopeSet",
		[cannotAppendScopeSet]: "Cannot append ScopeSet",
		[emptyInputScopeSet]: "Empty input ScopeSet cannot be processed",
		[deviceCodePollingCancelled]: "Caller has cancelled token endpoint polling during device code flow by setting DeviceCodeRequest.cancel = true.",
		[deviceCodeExpired]: "Device code is expired.",
		[deviceCodeUnknownError]: "Device code stopped polling for unknown reasons.",
		[noAccountInSilentRequest]: "Please pass an account object, silent flow is not supported without account information",
		[invalidCacheRecord]: "Cache record object was null or undefined.",
		[invalidCacheEnvironment]: "Invalid environment when attempting to create cache entry",
		[noAccountFound]: "No account found in cache for given key.",
		[noCryptoObject]: "No crypto object detected.",
		[unexpectedCredentialType]: "Unexpected credential type.",
		[invalidAssertion]: "Client assertion must meet requirements described in https://tools.ietf.org/html/rfc7515",
		[invalidClientCredential]: "Client credential (secret, certificate, or assertion) must not be empty when creating a confidential client. An application should at most have one credential",
		[tokenRefreshRequired]: "Cannot return token from cache because it must be refreshed. This may be due to one of the following reasons: forceRefresh parameter is set to true, claims have been requested, there is no cached access token or it is expired.",
		[userTimeoutReached]: "User defined timeout for device code polling reached",
		[tokenClaimsCnfRequiredForSignedJwt]: "Cannot generate a POP jwt if the token_claims are not populated",
		[authorizationCodeMissingFromServerResponse]: "Server response does not contain an authorization code to proceed",
		[bindingKeyNotRemoved]: "Could not remove the credential's binding key from storage.",
		[endSessionEndpointNotSupported]: "The provided authority does not support logout",
		[keyIdMissing]: "A keyId value is missing from the requested bound token's cache record and is required to match the token to it's stored binding key.",
		[noNetworkConnectivity]: "No network connectivity. Check your internet connection.",
		[userCanceled]: "User cancelled the flow.",
		[missingTenantIdError]: "A tenant id - not common, organizations, or consumers - must be specified when using the client_credentials flow.",
		[methodNotImplemented]: "This method has not been implemented",
		[nestedAppAuthBridgeDisabled]: "The nested app auth bridge is disabled",
		[platformBrokerError]: "An error occurred in the native broker. See the platformBrokerError property for details."
	};
	/**
	* String constants used by error codes and messages.
	* @deprecated Use ClientAuthErrorCodes instead
	*/
	const ClientAuthErrorMessage = {
		clientInfoDecodingError: {
			code: clientInfoDecodingError,
			desc: ClientAuthErrorMessages[clientInfoDecodingError]
		},
		clientInfoEmptyError: {
			code: clientInfoEmptyError,
			desc: ClientAuthErrorMessages[clientInfoEmptyError]
		},
		tokenParsingError: {
			code: tokenParsingError,
			desc: ClientAuthErrorMessages[tokenParsingError]
		},
		nullOrEmptyToken: {
			code: nullOrEmptyToken,
			desc: ClientAuthErrorMessages[nullOrEmptyToken]
		},
		endpointResolutionError: {
			code: endpointResolutionError,
			desc: ClientAuthErrorMessages[endpointResolutionError]
		},
		networkError: {
			code: networkError,
			desc: ClientAuthErrorMessages[networkError]
		},
		unableToGetOpenidConfigError: {
			code: openIdConfigError,
			desc: ClientAuthErrorMessages[openIdConfigError]
		},
		hashNotDeserialized: {
			code: hashNotDeserialized,
			desc: ClientAuthErrorMessages[hashNotDeserialized]
		},
		invalidStateError: {
			code: invalidState,
			desc: ClientAuthErrorMessages[invalidState]
		},
		stateMismatchError: {
			code: stateMismatch,
			desc: ClientAuthErrorMessages[stateMismatch]
		},
		stateNotFoundError: {
			code: stateNotFound,
			desc: ClientAuthErrorMessages[stateNotFound]
		},
		nonceMismatchError: {
			code: nonceMismatch,
			desc: ClientAuthErrorMessages[nonceMismatch]
		},
		authTimeNotFoundError: {
			code: authTimeNotFound,
			desc: ClientAuthErrorMessages[authTimeNotFound]
		},
		maxAgeTranspired: {
			code: maxAgeTranspired,
			desc: ClientAuthErrorMessages[maxAgeTranspired]
		},
		multipleMatchingTokens: {
			code: multipleMatchingTokens,
			desc: ClientAuthErrorMessages[multipleMatchingTokens]
		},
		multipleMatchingAccounts: {
			code: multipleMatchingAccounts,
			desc: ClientAuthErrorMessages[multipleMatchingAccounts]
		},
		multipleMatchingAppMetadata: {
			code: multipleMatchingAppMetadata,
			desc: ClientAuthErrorMessages[multipleMatchingAppMetadata]
		},
		tokenRequestCannotBeMade: {
			code: requestCannotBeMade,
			desc: ClientAuthErrorMessages[requestCannotBeMade]
		},
		removeEmptyScopeError: {
			code: cannotRemoveEmptyScope,
			desc: ClientAuthErrorMessages[cannotRemoveEmptyScope]
		},
		appendScopeSetError: {
			code: cannotAppendScopeSet,
			desc: ClientAuthErrorMessages[cannotAppendScopeSet]
		},
		emptyInputScopeSetError: {
			code: emptyInputScopeSet,
			desc: ClientAuthErrorMessages[emptyInputScopeSet]
		},
		DeviceCodePollingCancelled: {
			code: deviceCodePollingCancelled,
			desc: ClientAuthErrorMessages[deviceCodePollingCancelled]
		},
		DeviceCodeExpired: {
			code: deviceCodeExpired,
			desc: ClientAuthErrorMessages[deviceCodeExpired]
		},
		DeviceCodeUnknownError: {
			code: deviceCodeUnknownError,
			desc: ClientAuthErrorMessages[deviceCodeUnknownError]
		},
		NoAccountInSilentRequest: {
			code: noAccountInSilentRequest,
			desc: ClientAuthErrorMessages[noAccountInSilentRequest]
		},
		invalidCacheRecord: {
			code: invalidCacheRecord,
			desc: ClientAuthErrorMessages[invalidCacheRecord]
		},
		invalidCacheEnvironment: {
			code: invalidCacheEnvironment,
			desc: ClientAuthErrorMessages[invalidCacheEnvironment]
		},
		noAccountFound: {
			code: noAccountFound,
			desc: ClientAuthErrorMessages[noAccountFound]
		},
		noCryptoObj: {
			code: noCryptoObject,
			desc: ClientAuthErrorMessages[noCryptoObject]
		},
		unexpectedCredentialType: {
			code: unexpectedCredentialType,
			desc: ClientAuthErrorMessages[unexpectedCredentialType]
		},
		invalidAssertion: {
			code: invalidAssertion,
			desc: ClientAuthErrorMessages[invalidAssertion]
		},
		invalidClientCredential: {
			code: invalidClientCredential,
			desc: ClientAuthErrorMessages[invalidClientCredential]
		},
		tokenRefreshRequired: {
			code: tokenRefreshRequired,
			desc: ClientAuthErrorMessages[tokenRefreshRequired]
		},
		userTimeoutReached: {
			code: userTimeoutReached,
			desc: ClientAuthErrorMessages[userTimeoutReached]
		},
		tokenClaimsRequired: {
			code: tokenClaimsCnfRequiredForSignedJwt,
			desc: ClientAuthErrorMessages[tokenClaimsCnfRequiredForSignedJwt]
		},
		noAuthorizationCodeFromServer: {
			code: authorizationCodeMissingFromServerResponse,
			desc: ClientAuthErrorMessages[authorizationCodeMissingFromServerResponse]
		},
		bindingKeyNotRemovedError: {
			code: bindingKeyNotRemoved,
			desc: ClientAuthErrorMessages[bindingKeyNotRemoved]
		},
		logoutNotSupported: {
			code: endSessionEndpointNotSupported,
			desc: ClientAuthErrorMessages[endSessionEndpointNotSupported]
		},
		keyIdMissing: {
			code: keyIdMissing,
			desc: ClientAuthErrorMessages[keyIdMissing]
		},
		noNetworkConnectivity: {
			code: noNetworkConnectivity,
			desc: ClientAuthErrorMessages[noNetworkConnectivity]
		},
		userCanceledError: {
			code: userCanceled,
			desc: ClientAuthErrorMessages[userCanceled]
		},
		missingTenantIdError: {
			code: missingTenantIdError,
			desc: ClientAuthErrorMessages[missingTenantIdError]
		},
		nestedAppAuthBridgeDisabled: {
			code: nestedAppAuthBridgeDisabled,
			desc: ClientAuthErrorMessages[nestedAppAuthBridgeDisabled]
		},
		platformBrokerError: {
			code: platformBrokerError,
			desc: ClientAuthErrorMessages[platformBrokerError]
		}
	};
	/**
	* Error thrown when there is an error in the client code running on the browser.
	*/
	var ClientAuthError = class ClientAuthError extends AuthError {
		constructor(errorCode, additionalMessage) {
			super(errorCode, additionalMessage ? `${ClientAuthErrorMessages[errorCode]}: ${additionalMessage}` : ClientAuthErrorMessages[errorCode]);
			this.name = "ClientAuthError";
			Object.setPrototypeOf(this, ClientAuthError.prototype);
		}
	};
	function createClientAuthError(errorCode, additionalMessage) {
		return new ClientAuthError(errorCode, additionalMessage);
	}
	/**
	* Extract token by decoding the rawToken
	*
	* @param encodedToken
	*/
	function extractTokenClaims(encodedToken, base64Decode) {
		const jswPayload = getJWSPayload(encodedToken);
		try {
			const base64Decoded = base64Decode(jswPayload);
			return JSON.parse(base64Decoded);
		} catch (err) {
			throw createClientAuthError(tokenParsingError);
		}
	}
	/**
	* Check if the signin_state claim contains "kmsi"
	* @param idTokenClaims
	* @returns
	*/
	function isKmsi(idTokenClaims) {
		if (!idTokenClaims.signin_state) return false;
		/**
		* Signin_state claim known values:
		* dvc_mngd - device is managed
		* dvc_dmjd - device is domain joined
		* kmsi - user opted to "keep me signed in"
		* inknownntwk - Request made inside a known network. Don't use this, use CAE instead.
		*/
		const kmsiClaims = ["kmsi", "dvc_dmjd"];
		return idTokenClaims.signin_state.some((value) => kmsiClaims.includes(value.trim().toLowerCase()));
	}
	/**
	* decode a JWT
	*
	* @param authToken
	*/
	function getJWSPayload(authToken) {
		if (!authToken) throw createClientAuthError(nullOrEmptyToken);
		const matches = /^([^\.\s]*)\.([^\.\s]+)\.([^\.\s]*)$/.exec(authToken);
		if (!matches || matches.length < 4) throw createClientAuthError(tokenParsingError);
		/**
		* const crackedToken = {
		*  header: matches[1],
		*  JWSPayload: matches[2],
		*  JWSSig: matches[3],
		* };
		*/
		return matches[2];
	}
	/**
	* Determine if the token's max_age has transpired
	*/
	function checkMaxAge(authTime, maxAge) {
		if (maxAge === 0 || Date.now() - 3e5 > authTime + maxAge) throw createClientAuthError(maxAgeTranspired);
	}
	var AuthToken = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		checkMaxAge,
		extractTokenClaims,
		getJWSPayload,
		isKmsi
	});
	/**
	* Authority types supported by MSAL.
	*/
	const AuthorityType = {
		Default: 0,
		Adfs: 1,
		Dsts: 2,
		Ciam: 3
	};
	function isOpenIdConfigResponse(response) {
		return response.hasOwnProperty("authorization_endpoint") && response.hasOwnProperty("token_endpoint") && response.hasOwnProperty("issuer") && response.hasOwnProperty("jwks_uri");
	}
	const redirectUriEmpty = "redirect_uri_empty";
	const claimsRequestParsingError = "claims_request_parsing_error";
	const authorityUriInsecure = "authority_uri_insecure";
	const urlParseError = "url_parse_error";
	const urlEmptyError = "empty_url_error";
	const emptyInputScopesError = "empty_input_scopes_error";
	const invalidClaims = "invalid_claims";
	const tokenRequestEmpty = "token_request_empty";
	const logoutRequestEmpty = "logout_request_empty";
	const invalidCodeChallengeMethod = "invalid_code_challenge_method";
	const pkceParamsMissing = "pkce_params_missing";
	const invalidCloudDiscoveryMetadata = "invalid_cloud_discovery_metadata";
	const invalidAuthorityMetadata = "invalid_authority_metadata";
	const untrustedAuthority = "untrusted_authority";
	const missingSshJwk = "missing_ssh_jwk";
	const missingSshKid = "missing_ssh_kid";
	const missingNonceAuthenticationHeader = "missing_nonce_authentication_header";
	const invalidAuthenticationHeader = "invalid_authentication_header";
	const cannotSetOIDCOptions = "cannot_set_OIDCOptions";
	const cannotAllowPlatformBroker = "cannot_allow_platform_broker";
	const authorityMismatch = "authority_mismatch";
	const invalidRequestMethodForEAR = "invalid_request_method_for_EAR";
	const invalidAuthorizePostBodyParameters = "invalid_authorize_post_body_parameters";
	const invalidPlatformBrokerConfiguration = "invalid_platform_broker_configuration";
	var ClientConfigurationErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		authorityMismatch,
		authorityUriInsecure,
		cannotAllowPlatformBroker,
		cannotSetOIDCOptions,
		claimsRequestParsingError,
		emptyInputScopesError,
		invalidAuthenticationHeader,
		invalidAuthorityMetadata,
		invalidAuthorizePostBodyParameters,
		invalidClaims,
		invalidCloudDiscoveryMetadata,
		invalidCodeChallengeMethod,
		invalidPlatformBrokerConfiguration,
		invalidRequestMethodForEAR,
		logoutRequestEmpty,
		missingNonceAuthenticationHeader,
		missingSshJwk,
		missingSshKid,
		pkceParamsMissing,
		redirectUriEmpty,
		tokenRequestEmpty,
		untrustedAuthority,
		urlEmptyError,
		urlParseError
	});
	const ClientConfigurationErrorMessages = {
		[redirectUriEmpty]: "A redirect URI is required for all calls, and none has been set.",
		[claimsRequestParsingError]: "Could not parse the given claims request object.",
		[authorityUriInsecure]: "Authority URIs must use https.  Please see here for valid authority configuration options: https://docs.microsoft.com/en-us/azure/active-directory/develop/msal-js-initializing-client-applications#configuration-options",
		[urlParseError]: "URL could not be parsed into appropriate segments.",
		[urlEmptyError]: "URL was empty or null.",
		[emptyInputScopesError]: "Scopes cannot be passed as null, undefined or empty array because they are required to obtain an access token.",
		[invalidClaims]: "Given claims parameter must be a stringified JSON object.",
		[tokenRequestEmpty]: "Token request was empty and not found in cache.",
		[logoutRequestEmpty]: "The logout request was null or undefined.",
		[invalidCodeChallengeMethod]: "code_challenge_method passed is invalid. Valid values are \"plain\" and \"S256\".",
		[pkceParamsMissing]: "Both params: code_challenge and code_challenge_method are to be passed if to be sent in the request",
		[invalidCloudDiscoveryMetadata]: "Invalid cloudDiscoveryMetadata provided. Must be a stringified JSON object containing tenant_discovery_endpoint and metadata fields",
		[invalidAuthorityMetadata]: "Invalid authorityMetadata provided. Must by a stringified JSON object containing authorization_endpoint, token_endpoint, issuer fields.",
		[untrustedAuthority]: "The provided authority is not a trusted authority. Please include this authority in the knownAuthorities config parameter.",
		[missingSshJwk]: "Missing sshJwk in SSH certificate request. A stringified JSON Web Key is required when using the SSH authentication scheme.",
		[missingSshKid]: "Missing sshKid in SSH certificate request. A string that uniquely identifies the public SSH key is required when using the SSH authentication scheme.",
		[missingNonceAuthenticationHeader]: "Unable to find an authentication header containing server nonce. Either the Authentication-Info or WWW-Authenticate headers must be present in order to obtain a server nonce.",
		[invalidAuthenticationHeader]: "Invalid authentication header provided",
		[cannotSetOIDCOptions]: "Cannot set OIDCOptions parameter. Please change the protocol mode to OIDC or use a non-Microsoft authority.",
		[cannotAllowPlatformBroker]: "Cannot set allowPlatformBroker parameter to true when not in AAD protocol mode.",
		[authorityMismatch]: "Authority mismatch error. Authority provided in login request or PublicClientApplication config does not match the environment of the provided account. Please use a matching account or make an interactive request to login to this authority.",
		[invalidAuthorizePostBodyParameters]: "Invalid authorize post body parameters provided. If you are using authorizePostBodyParameters, the request method must be POST. Please check the request method and parameters.",
		[invalidRequestMethodForEAR]: "Invalid request method for EAR protocol mode. The request method cannot be GET when using EAR protocol mode. Please change the request method to POST.",
		[invalidPlatformBrokerConfiguration]: "Invalid platform broker configuration. `allowPlatformBrokerWithDOM` can only be enabled when `allowPlatformBroker` is enabled."
	};
	/**
	* ClientConfigurationErrorMessage class containing string constants used by error codes and messages.
	* @deprecated Use ClientConfigurationErrorCodes instead
	*/
	const ClientConfigurationErrorMessage = {
		redirectUriNotSet: {
			code: redirectUriEmpty,
			desc: ClientConfigurationErrorMessages[redirectUriEmpty]
		},
		claimsRequestParsingError: {
			code: claimsRequestParsingError,
			desc: ClientConfigurationErrorMessages[claimsRequestParsingError]
		},
		authorityUriInsecure: {
			code: authorityUriInsecure,
			desc: ClientConfigurationErrorMessages[authorityUriInsecure]
		},
		urlParseError: {
			code: urlParseError,
			desc: ClientConfigurationErrorMessages[urlParseError]
		},
		urlEmptyError: {
			code: urlEmptyError,
			desc: ClientConfigurationErrorMessages[urlEmptyError]
		},
		emptyScopesError: {
			code: emptyInputScopesError,
			desc: ClientConfigurationErrorMessages[emptyInputScopesError]
		},
		invalidClaimsRequest: {
			code: invalidClaims,
			desc: ClientConfigurationErrorMessages[invalidClaims]
		},
		tokenRequestEmptyError: {
			code: tokenRequestEmpty,
			desc: ClientConfigurationErrorMessages[tokenRequestEmpty]
		},
		logoutRequestEmptyError: {
			code: logoutRequestEmpty,
			desc: ClientConfigurationErrorMessages[logoutRequestEmpty]
		},
		invalidCodeChallengeMethod: {
			code: invalidCodeChallengeMethod,
			desc: ClientConfigurationErrorMessages[invalidCodeChallengeMethod]
		},
		invalidCodeChallengeParams: {
			code: pkceParamsMissing,
			desc: ClientConfigurationErrorMessages[pkceParamsMissing]
		},
		invalidCloudDiscoveryMetadata: {
			code: invalidCloudDiscoveryMetadata,
			desc: ClientConfigurationErrorMessages[invalidCloudDiscoveryMetadata]
		},
		invalidAuthorityMetadata: {
			code: invalidAuthorityMetadata,
			desc: ClientConfigurationErrorMessages[invalidAuthorityMetadata]
		},
		untrustedAuthority: {
			code: untrustedAuthority,
			desc: ClientConfigurationErrorMessages[untrustedAuthority]
		},
		missingSshJwk: {
			code: missingSshJwk,
			desc: ClientConfigurationErrorMessages[missingSshJwk]
		},
		missingSshKid: {
			code: missingSshKid,
			desc: ClientConfigurationErrorMessages[missingSshKid]
		},
		missingNonceAuthenticationHeader: {
			code: missingNonceAuthenticationHeader,
			desc: ClientConfigurationErrorMessages[missingNonceAuthenticationHeader]
		},
		invalidAuthenticationHeader: {
			code: invalidAuthenticationHeader,
			desc: ClientConfigurationErrorMessages[invalidAuthenticationHeader]
		},
		cannotSetOIDCOptions: {
			code: cannotSetOIDCOptions,
			desc: ClientConfigurationErrorMessages[cannotSetOIDCOptions]
		},
		cannotAllowPlatformBroker: {
			code: cannotAllowPlatformBroker,
			desc: ClientConfigurationErrorMessages[cannotAllowPlatformBroker]
		},
		authorityMismatch: {
			code: authorityMismatch,
			desc: ClientConfigurationErrorMessages[authorityMismatch]
		},
		invalidAuthorizePostBodyParameters: {
			code: invalidAuthorizePostBodyParameters,
			desc: ClientConfigurationErrorMessages[invalidAuthorizePostBodyParameters]
		},
		invalidRequestMethodForEAR: {
			code: invalidRequestMethodForEAR,
			desc: ClientConfigurationErrorMessages[invalidRequestMethodForEAR]
		},
		invalidPlatformBrokerConfiguration: {
			code: invalidPlatformBrokerConfiguration,
			desc: ClientConfigurationErrorMessages[invalidPlatformBrokerConfiguration]
		}
	};
	/**
	* Error thrown when there is an error in configuration of the MSAL.js library.
	*/
	var ClientConfigurationError = class ClientConfigurationError extends AuthError {
		constructor(errorCode) {
			super(errorCode, ClientConfigurationErrorMessages[errorCode]);
			this.name = "ClientConfigurationError";
			Object.setPrototypeOf(this, ClientConfigurationError.prototype);
		}
	};
	function createClientConfigurationError(errorCode) {
		return new ClientConfigurationError(errorCode);
	}
	/**
	* @hidden
	*/
	var StringUtils = class {
		/**
		* Check if stringified object is empty
		* @param strObj
		*/
		static isEmptyObj(strObj) {
			if (strObj) try {
				const obj = JSON.parse(strObj);
				return Object.keys(obj).length === 0;
			} catch (e) {}
			return true;
		}
		static startsWith(str, search) {
			return str.indexOf(search) === 0;
		}
		static endsWith(str, search) {
			return str.length >= search.length && str.lastIndexOf(search) === str.length - search.length;
		}
		/**
		* Parses string into an object.
		*
		* @param query
		*/
		static queryStringToObject(query) {
			const obj = {};
			const params = query.split("&");
			const decode = (s) => decodeURIComponent(s.replace(/\+/g, " "));
			params.forEach((pair) => {
				if (pair.trim()) {
					const [key, value] = pair.split(/=(.+)/g, 2);
					if (key && value) obj[decode(key)] = decode(value);
				}
			});
			return obj;
		}
		/**
		* Trims entries in an array.
		*
		* @param arr
		*/
		static trimArrayEntries(arr) {
			return arr.map((entry) => entry.trim());
		}
		/**
		* Removes empty strings from array
		* @param arr
		*/
		static removeEmptyStringsFromArray(arr) {
			return arr.filter((entry) => {
				return !!entry;
			});
		}
		/**
		* Attempts to parse a string into JSON
		* @param str
		*/
		static jsonParseHelper(str) {
			try {
				return JSON.parse(str);
			} catch (e) {
				return null;
			}
		}
		/**
		* Tests if a given string matches a given pattern, with support for wildcards and queries.
		* @param pattern Wildcard pattern to string match. Supports "*" for wildcards and "?" for queries
		* @param input String to match against
		*/
		static matchPattern(pattern, input) {
			return new RegExp(pattern.replace(/\\/g, "\\\\").replace(/\*/g, "[^ ]*").replace(/\?/g, "\\?")).test(input);
		}
		/**
		* Tests if a given string matches a given pattern using stricter, anchored matching semantics.
		*
		* Differences from `matchPattern` (legacy):
		* - All regex metacharacters (including `.`) in the pattern are treated as literals,
		*   so `example.com` matches only `example.com` and not `exampleXcom`.
		* - The generated regex is anchored with `^` and `$` so partial/substring matches
		*   are not allowed.
		* - `*` is the only supported wildcard. Its behaviour depends on the URL component:
		*   - `host` component: `*` matches any sequence of characters that does NOT include
		*     a dot (`.`), keeping wildcards within a single DNS label boundary.
		*   - All other components: `*` matches any sequence of characters (including `/`).
		*
		* @param pattern - The `protectedResourceMap` key pattern to match against. `*` is a
		*   multi-character wildcard; all other characters are treated as literals.
		* @param input - The URL component value (e.g. host, pathname) extracted from the
		*   outgoing request URL to test against the pattern.
		* @param options - Optional. Provide `component` to enable component-aware wildcard
		*   semantics. Accepted values: `"host"`, `"path"`, `"protocol"`, `"search"`,
		*   `"hash"`. Defaults to path-style (permissive) matching when omitted.
		* @returns `true` if the full input string matches the pattern; `false` otherwise.
		*/
		static matchPatternStrict(pattern, input, options) {
			const component = options?.component;
			let regexBody = pattern.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
			if (component === "host") regexBody = regexBody.replace(/\\\*/g, "[^.]*");
			else regexBody = regexBody.replace(/\\\*/g, ".*");
			return new RegExp(`^${regexBody}$`).test(input);
		}
	};
	/**
	* Canonicalizes a URL by making it lowercase and ensuring it ends with /
	* Inlined version of UrlString.canonicalizeUri to avoid circular dependency
	* @param url - URL to canonicalize
	* @returns Canonicalized URL
	*/
	function canonicalizeUrl(url) {
		if (!url) return url;
		let lowerCaseUrl = url.toLowerCase();
		if (StringUtils.endsWith(lowerCaseUrl, "?")) lowerCaseUrl = lowerCaseUrl.slice(0, -1);
		else if (StringUtils.endsWith(lowerCaseUrl, "?/")) lowerCaseUrl = lowerCaseUrl.slice(0, -2);
		if (!StringUtils.endsWith(lowerCaseUrl, "/")) lowerCaseUrl += "/";
		return lowerCaseUrl;
	}
	/**
	* Parses hash string from given string. Returns empty string if no hash symbol is found.
	* @param hashString
	*/
	function stripLeadingHashOrQuery(responseString) {
		if (responseString.startsWith("#/")) return responseString.substring(2);
		else if (responseString.startsWith("#") || responseString.startsWith("?")) return responseString.substring(1);
		return responseString;
	}
	/**
	* Returns URL hash as server auth code response object.
	*/
	function getDeserializedResponse(responseString) {
		if (!responseString || responseString.indexOf("=") < 0) return null;
		try {
			const normalizedResponse = stripLeadingHashOrQuery(responseString);
			const deserializedHash = Object.fromEntries(new URLSearchParams(normalizedResponse));
			if (deserializedHash.code || deserializedHash.ear_jwe || deserializedHash.error || deserializedHash.error_description || deserializedHash.state) return deserializedHash;
		} catch (e) {
			throw createClientAuthError(hashNotDeserialized);
		}
		return null;
	}
	/**
	* Utility to create a URL from the params map
	*/
	function mapToQueryString(parameters, encodeExtraParams = true, extraQueryParameters) {
		const queryParameterArray = new Array();
		parameters.forEach((value, key) => {
			if (!encodeExtraParams && extraQueryParameters && key in extraQueryParameters) queryParameterArray.push(`${key}=${value}`);
			else queryParameterArray.push(`${key}=${encodeURIComponent(value)}`);
		});
		return queryParameterArray.join("&");
	}
	/**
	* Normalizes URLs for comparison by removing hash, canonicalizing,
	* and ensuring consistent URL encoding in query parameters.
	* This fixes redirect loops when URLs contain encoded characters like apostrophes (%27).
	* @param url - URL to normalize
	* @returns Normalized URL string for comparison
	*/
	function normalizeUrlForComparison(url) {
		if (!url) return url;
		const urlWithoutHash = url.split("#")[0];
		try {
			const urlObj = new URL(urlWithoutHash);
			return canonicalizeUrl(urlObj.origin + urlObj.pathname + urlObj.search);
		} catch (e) {
			return canonicalizeUrl(urlWithoutHash);
		}
	}
	var UrlUtils = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		getDeserializedResponse,
		mapToQueryString,
		normalizeUrlForComparison,
		stripLeadingHashOrQuery
	});
	/**
	* Url object class which can perform various transformations on url strings.
	*/
	var UrlString = class UrlString {
		get urlString() {
			return this._urlString;
		}
		constructor(url) {
			this._urlString = url;
			if (!this._urlString) throw createClientConfigurationError(urlEmptyError);
			if (!url.includes("#")) this._urlString = UrlString.canonicalizeUri(url);
		}
		/**
		* Ensure urls are lower case and end with a / character.
		* @param url
		*/
		static canonicalizeUri(url) {
			if (url) {
				let lowerCaseUrl = url.toLowerCase();
				if (StringUtils.endsWith(lowerCaseUrl, "?")) lowerCaseUrl = lowerCaseUrl.slice(0, -1);
				else if (StringUtils.endsWith(lowerCaseUrl, "?/")) lowerCaseUrl = lowerCaseUrl.slice(0, -2);
				if (!StringUtils.endsWith(lowerCaseUrl, "/")) lowerCaseUrl += "/";
				return lowerCaseUrl;
			}
			return url;
		}
		/**
		* Throws if urlString passed is not a valid authority URI string.
		*/
		validateAsUri() {
			let components;
			try {
				components = this.getUrlComponents();
			} catch (e) {
				throw createClientConfigurationError(urlParseError);
			}
			if (!components.HostNameAndPort || !components.PathSegments) throw createClientConfigurationError(urlParseError);
			if (!components.Protocol || components.Protocol.toLowerCase() !== "https:") throw createClientConfigurationError(authorityUriInsecure);
		}
		/**
		* Given a url and a query string return the url with provided query string appended
		* @param url
		* @param queryString
		*/
		static appendQueryString(url, queryString) {
			if (!queryString) return url;
			return url.indexOf("?") < 0 ? `${url}?${queryString}` : `${url}&${queryString}`;
		}
		/**
		* Returns a url with the hash removed
		* @param url
		*/
		static removeHashFromUrl(url) {
			return UrlString.canonicalizeUri(url.split("#")[0]);
		}
		/**
		* Given a url like https://a:b/common/d?e=f#g, and a tenantId, returns https://a:b/tenantId/d
		* @param href The url
		* @param tenantId The tenant id to replace
		*/
		replaceTenantPath(tenantId) {
			const urlObject = this.getUrlComponents();
			const pathArray = urlObject.PathSegments;
			if (tenantId && pathArray.length !== 0 && (pathArray[0] === AADAuthorityConstants.COMMON || pathArray[0] === AADAuthorityConstants.ORGANIZATIONS)) pathArray[0] = tenantId;
			return UrlString.constructAuthorityUriFromObject(urlObject);
		}
		/**
		* Parses out the components from a url string.
		* @returns An object with the various components. Please cache this value insted of calling this multiple times on the same url.
		*/
		getUrlComponents() {
			const regEx = RegExp("^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?");
			const match = this.urlString.match(regEx);
			if (!match) throw createClientConfigurationError(urlParseError);
			const urlComponents = {
				Protocol: match[1],
				HostNameAndPort: match[4],
				AbsolutePath: match[5],
				QueryString: match[7]
			};
			let pathSegments = urlComponents.AbsolutePath.split("/");
			pathSegments = pathSegments.filter((val) => val && val.length > 0);
			urlComponents.PathSegments = pathSegments;
			if (urlComponents.QueryString && urlComponents.QueryString.endsWith("/")) urlComponents.QueryString = urlComponents.QueryString.substring(0, urlComponents.QueryString.length - 1);
			return urlComponents;
		}
		static getDomainFromUrl(url) {
			const regEx = RegExp("^([^:/?#]+://)?([^/?#]*)");
			const match = url.match(regEx);
			if (!match) throw createClientConfigurationError(urlParseError);
			return match[2];
		}
		static getAbsoluteUrl(relativeUrl, baseUrl) {
			if (relativeUrl[0] === Constants.FORWARD_SLASH) {
				const baseComponents = new UrlString(baseUrl).getUrlComponents();
				return baseComponents.Protocol + "//" + baseComponents.HostNameAndPort + relativeUrl;
			}
			return relativeUrl;
		}
		static constructAuthorityUriFromObject(urlObject) {
			return new UrlString(urlObject.Protocol + "//" + urlObject.HostNameAndPort + "/" + urlObject.PathSegments.join("/"));
		}
		/**
		* Check if the hash of the URL string contains known properties
		* @deprecated This API will be removed in a future version
		*/
		static hashContainsKnownProperties(response) {
			return !!getDeserializedResponse(response);
		}
	};
	const rawMetdataJSON = {
		endpointMetadata: {
			"login.microsoftonline.com": {
				token_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.microsoftonline.com/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
				authorization_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/logout"
			},
			"login.chinacloudapi.cn": {
				token_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.chinacloudapi.cn/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.partner.microsoftonline.cn/{tenantid}/v2.0",
				authorization_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/logout"
			},
			"login.microsoftonline.us": {
				token_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.microsoftonline.us/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.microsoftonline.us/{tenantid}/v2.0",
				authorization_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.fr": {
				token_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.fr/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.fr/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.de": {
				token_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.de/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.de/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.sg": {
				token_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.sg/common/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.sg/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/logout"
			}
		},
		instanceDiscoveryMetadata: { metadata: [
			{
				preferred_network: "login.microsoftonline.com",
				preferred_cache: "login.windows.net",
				aliases: [
					"login.microsoftonline.com",
					"login.windows.net",
					"login.microsoft.com",
					"sts.windows.net"
				]
			},
			{
				preferred_network: "login.partner.microsoftonline.cn",
				preferred_cache: "login.partner.microsoftonline.cn",
				aliases: ["login.partner.microsoftonline.cn", "login.chinacloudapi.cn"]
			},
			{
				preferred_network: "login.microsoftonline.de",
				preferred_cache: "login.microsoftonline.de",
				aliases: ["login.microsoftonline.de"]
			},
			{
				preferred_network: "login.microsoftonline.us",
				preferred_cache: "login.microsoftonline.us",
				aliases: ["login.microsoftonline.us", "login.usgovcloudapi.net"]
			},
			{
				preferred_network: "login-us.microsoftonline.com",
				preferred_cache: "login-us.microsoftonline.com",
				aliases: ["login-us.microsoftonline.com"]
			},
			{
				preferred_network: "login.sovcloud-identity.fr",
				preferred_cache: "login.sovcloud-identity.fr",
				aliases: ["login.sovcloud-identity.fr"]
			},
			{
				preferred_network: "login.sovcloud-identity.de",
				preferred_cache: "login.sovcloud-identity.de",
				aliases: ["login.sovcloud-identity.de"]
			},
			{
				preferred_network: "login.sovcloud-identity.sg",
				preferred_cache: "login.sovcloud-identity.sg",
				aliases: ["login.sovcloud-identity.sg"]
			}
		] }
	};
	const EndpointMetadata = rawMetdataJSON.endpointMetadata;
	const InstanceDiscoveryMetadata = rawMetdataJSON.instanceDiscoveryMetadata;
	const InstanceDiscoveryMetadataAliases = /* @__PURE__ */ new Set();
	InstanceDiscoveryMetadata.metadata.forEach((metadataEntry) => {
		metadataEntry.aliases.forEach((alias) => {
			InstanceDiscoveryMetadataAliases.add(alias);
		});
	});
	/**
	* Attempts to get an aliases array from the static authority metadata sources based on the canonical authority host
	* @param staticAuthorityOptions
	* @param logger
	* @returns
	*/
	function getAliasesFromStaticSources(staticAuthorityOptions, logger) {
		let staticAliases;
		const canonicalAuthority = staticAuthorityOptions.canonicalAuthority;
		if (canonicalAuthority) {
			const authorityHost = new UrlString(canonicalAuthority).getUrlComponents().HostNameAndPort;
			staticAliases = getAliasesFromMetadata(authorityHost, staticAuthorityOptions.cloudDiscoveryMetadata?.metadata, AuthorityMetadataSource.CONFIG, logger) || getAliasesFromMetadata(authorityHost, InstanceDiscoveryMetadata.metadata, AuthorityMetadataSource.HARDCODED_VALUES, logger) || staticAuthorityOptions.knownAuthorities;
		}
		return staticAliases || [];
	}
	/**
	* Returns aliases for from the raw cloud discovery metadata passed in
	* @param authorityHost
	* @param rawCloudDiscoveryMetadata
	* @returns
	*/
	function getAliasesFromMetadata(authorityHost, cloudDiscoveryMetadata, source, logger) {
		logger?.trace(`getAliasesFromMetadata called with source: ${source}`);
		if (authorityHost && cloudDiscoveryMetadata) {
			const metadata = getCloudDiscoveryMetadataFromNetworkResponse(cloudDiscoveryMetadata, authorityHost);
			if (metadata) {
				logger?.trace(`getAliasesFromMetadata: found cloud discovery metadata in ${source}, returning aliases`);
				return metadata.aliases;
			} else logger?.trace(`getAliasesFromMetadata: did not find cloud discovery metadata in ${source}`);
		}
		return null;
	}
	/**
	* Get cloud discovery metadata for common authorities
	*/
	function getCloudDiscoveryMetadataFromHardcodedValues(authorityHost) {
		return getCloudDiscoveryMetadataFromNetworkResponse(InstanceDiscoveryMetadata.metadata, authorityHost);
	}
	/**
	* Searches instance discovery network response for the entry that contains the host in the aliases list
	* @param response
	* @param authority
	*/
	function getCloudDiscoveryMetadataFromNetworkResponse(response, authorityHost) {
		for (let i = 0; i < response.length; i++) {
			const metadata = response[i];
			if (metadata.aliases.includes(authorityHost)) return metadata;
		}
		return null;
	}
	/**
	* Protocol modes supported by MSAL.
	*/
	const ProtocolMode = {
		/**
		* Auth Code + PKCE with Entra ID (formerly AAD) specific optimizations and features
		*/
		AAD: "AAD",
		/**
		* Auth Code + PKCE without Entra ID specific optimizations and features. For use only with non-Microsoft owned authorities.
		* Support is limited for this mode.
		*/
		OIDC: "OIDC",
		/**
		* Encrypted Authorize Response (EAR) with Entra ID specific optimizations and features
		*/
		EAR: "EAR"
	};
	const AzureCloudInstance = {
		None: "none",
		AzurePublic: "https://login.microsoftonline.com",
		AzurePpe: "https://login.windows-ppe.net",
		AzureChina: "https://login.chinacloudapi.cn",
		AzureGermany: "https://login.microsoftonline.de",
		AzureUsGovernment: "https://login.microsoftonline.us"
	};
	function isCloudInstanceDiscoveryResponse(response) {
		return response.hasOwnProperty("tenant_discovery_endpoint") && response.hasOwnProperty("metadata");
	}
	function isCloudInstanceDiscoveryErrorResponse(response) {
		return response.hasOwnProperty("error") && response.hasOwnProperty("error_description");
	}
	/**
	* Enumeration of operations that are instrumented by have their performance measured by the PerformanceClient.
	*
	* @export
	* @enum {number}
	*/
	const PerformanceEvents = {
		/**
		* acquireTokenByCode API (msal-browser and msal-node).
		* Used to acquire tokens by trading an authorization code against the token endpoint.
		*/
		AcquireTokenByCode: "acquireTokenByCode",
		/**
		* acquireTokenByRefreshToken API (msal-browser and msal-node).
		* Used to renew an access token using a refresh token against the token endpoint.
		*/
		AcquireTokenByRefreshToken: "acquireTokenByRefreshToken",
		/**
		* acquireTokenSilent API (msal-browser and msal-node).
		* Used to silently acquire a new access token (from the cache or the network).
		*/
		AcquireTokenSilent: "acquireTokenSilent",
		/**
		* acquireTokenSilentAsync (msal-browser).
		* Internal API for acquireTokenSilent.
		*/
		AcquireTokenSilentAsync: "acquireTokenSilentAsync",
		/**
		* acquireTokenPopup (msal-browser).
		* Used to acquire a new access token interactively through pop ups
		*/
		AcquireTokenPopup: "acquireTokenPopup",
		/**
		* acquireTokenPreRedirect (msal-browser).
		* First part of the redirect flow.
		* Used to acquire a new access token interactively through redirects.
		*/
		AcquireTokenPreRedirect: "acquireTokenPreRedirect",
		/**
		* acquireTokenRedirect (msal-browser).
		* Second part of the redirect flow.
		* Used to acquire a new access token interactively through redirects.
		*/
		AcquireTokenRedirect: "acquireTokenRedirect",
		/**
		* getPublicKeyThumbprint API in CryptoOpts class (msal-browser).
		* Used to generate a public/private keypair and generate a public key thumbprint for pop requests.
		*/
		CryptoOptsGetPublicKeyThumbprint: "cryptoOptsGetPublicKeyThumbprint",
		/**
		* signJwt API in CryptoOpts class (msal-browser).
		* Used to signed a pop token.
		*/
		CryptoOptsSignJwt: "cryptoOptsSignJwt",
		/**
		* acquireToken API in the SilentCacheClient class (msal-browser).
		* Used to read access tokens from the cache.
		*/
		SilentCacheClientAcquireToken: "silentCacheClientAcquireToken",
		/**
		* acquireToken API in the SilentIframeClient class (msal-browser).
		* Used to acquire a new set of tokens from the authorize endpoint in a hidden iframe.
		*/
		SilentIframeClientAcquireToken: "silentIframeClientAcquireToken",
		AwaitConcurrentIframe: "awaitConcurrentIframe",
		/**
		* acquireToken API in SilentRereshClient (msal-browser).
		* Used to acquire a new set of tokens from the token endpoint using a refresh token.
		*/
		SilentRefreshClientAcquireToken: "silentRefreshClientAcquireToken",
		/**
		* ssoSilent API (msal-browser).
		* Used to silently acquire an authorization code and set of tokens using a hidden iframe.
		*/
		SsoSilent: "ssoSilent",
		/**
		* getDiscoveredAuthority API in StandardInteractionClient class (msal-browser).
		* Used to load authority metadata for a request.
		*/
		StandardInteractionClientGetDiscoveredAuthority: "standardInteractionClientGetDiscoveredAuthority",
		/**
		* acquireToken APIs in msal-browser.
		* Used to make an /authorize endpoint call with native brokering enabled.
		*/
		FetchAccountIdWithNativeBroker: "fetchAccountIdWithNativeBroker",
		/**
		* acquireToken API in NativeInteractionClient class (msal-browser).
		* Used to acquire a token from Native component when native brokering is enabled.
		*/
		NativeInteractionClientAcquireToken: "nativeInteractionClientAcquireToken",
		/**
		* Time spent creating default headers for requests to token endpoint
		*/
		BaseClientCreateTokenRequestHeaders: "baseClientCreateTokenRequestHeaders",
		/**
		* Time spent sending/waiting for the response of a request to the token endpoint
		*/
		NetworkClientSendPostRequestAsync: "networkClientSendPostRequestAsync",
		RefreshTokenClientExecutePostToTokenEndpoint: "refreshTokenClientExecutePostToTokenEndpoint",
		AuthorizationCodeClientExecutePostToTokenEndpoint: "authorizationCodeClientExecutePostToTokenEndpoint",
		/**
		* Used to measure the time taken for completing embedded-broker handshake (PW-Broker).
		*/
		BrokerHandhshake: "brokerHandshake",
		/**
		* acquireTokenByRefreshToken API in BrokerClientApplication (PW-Broker) .
		*/
		AcquireTokenByRefreshTokenInBroker: "acquireTokenByRefreshTokenInBroker",
		/**
		* Time taken for token acquisition by broker
		*/
		AcquireTokenByBroker: "acquireTokenByBroker",
		/**
		* Time spent on the network for refresh token acquisition
		*/
		RefreshTokenClientExecuteTokenRequest: "refreshTokenClientExecuteTokenRequest",
		/**
		* Time taken for acquiring refresh token , records RT size
		*/
		RefreshTokenClientAcquireToken: "refreshTokenClientAcquireToken",
		/**
		* Time taken for acquiring cached refresh token
		*/
		RefreshTokenClientAcquireTokenWithCachedRefreshToken: "refreshTokenClientAcquireTokenWithCachedRefreshToken",
		/**
		* acquireTokenByRefreshToken API in RefreshTokenClient (msal-common).
		*/
		RefreshTokenClientAcquireTokenByRefreshToken: "refreshTokenClientAcquireTokenByRefreshToken",
		/**
		* Helper function to create token request body in RefreshTokenClient (msal-common).
		*/
		RefreshTokenClientCreateTokenRequestBody: "refreshTokenClientCreateTokenRequestBody",
		/**
		* acquireTokenFromCache (msal-browser).
		* Internal API for acquiring token from cache
		*/
		AcquireTokenFromCache: "acquireTokenFromCache",
		SilentFlowClientAcquireCachedToken: "silentFlowClientAcquireCachedToken",
		SilentFlowClientGenerateResultFromCacheRecord: "silentFlowClientGenerateResultFromCacheRecord",
		/**
		* acquireTokenBySilentIframe (msal-browser).
		* Internal API for acquiring token by silent Iframe
		*/
		AcquireTokenBySilentIframe: "acquireTokenBySilentIframe",
		/**
		* Internal API for initializing base request in BaseInteractionClient (msal-browser)
		*/
		InitializeBaseRequest: "initializeBaseRequest",
		/**
		* Internal API for initializing silent request in SilentCacheClient (msal-browser)
		*/
		InitializeSilentRequest: "initializeSilentRequest",
		InitializeClientApplication: "initializeClientApplication",
		InitializeCache: "initializeCache",
		/**
		* Helper function in SilentIframeClient class (msal-browser).
		*/
		SilentIframeClientTokenHelper: "silentIframeClientTokenHelper",
		/**
		* SilentHandler
		*/
		SilentHandlerInitiateAuthRequest: "silentHandlerInitiateAuthRequest",
		SilentHandlerMonitorIframeForHash: "silentHandlerMonitorIframeForHash",
		SilentHandlerLoadFrame: "silentHandlerLoadFrame",
		SilentHandlerLoadFrameSync: "silentHandlerLoadFrameSync",
		/**
		* Helper functions in StandardInteractionClient class (msal-browser)
		*/
		StandardInteractionClientCreateAuthCodeClient: "standardInteractionClientCreateAuthCodeClient",
		StandardInteractionClientGetClientConfiguration: "standardInteractionClientGetClientConfiguration",
		StandardInteractionClientInitializeAuthorizationRequest: "standardInteractionClientInitializeAuthorizationRequest",
		/**
		* getAuthCodeUrl API (msal-browser and msal-node).
		*/
		GetAuthCodeUrl: "getAuthCodeUrl",
		GetStandardParams: "getStandardParams",
		/**
		* Functions from InteractionHandler (msal-browser)
		*/
		HandleCodeResponseFromServer: "handleCodeResponseFromServer",
		HandleCodeResponse: "handleCodeResponse",
		HandleResponseEar: "handleResponseEar",
		HandleResponsePlatformBroker: "handleResponsePlatformBroker",
		HandleResponseCode: "handleResponseCode",
		UpdateTokenEndpointAuthority: "updateTokenEndpointAuthority",
		/**
		* APIs in Authorization Code Client (msal-common)
		*/
		AuthClientAcquireToken: "authClientAcquireToken",
		AuthClientExecuteTokenRequest: "authClientExecuteTokenRequest",
		AuthClientCreateTokenRequestBody: "authClientCreateTokenRequestBody",
		/**
		* Generate functions in PopTokenGenerator (msal-common)
		*/
		PopTokenGenerateCnf: "popTokenGenerateCnf",
		PopTokenGenerateKid: "popTokenGenerateKid",
		/**
		* handleServerTokenResponse API in ResponseHandler (msal-common)
		*/
		HandleServerTokenResponse: "handleServerTokenResponse",
		DeserializeResponse: "deserializeResponse",
		/**
		* Authority functions
		*/
		AuthorityFactoryCreateDiscoveredInstance: "authorityFactoryCreateDiscoveredInstance",
		AuthorityResolveEndpointsAsync: "authorityResolveEndpointsAsync",
		AuthorityResolveEndpointsFromLocalSources: "authorityResolveEndpointsFromLocalSources",
		AuthorityGetCloudDiscoveryMetadataFromNetwork: "authorityGetCloudDiscoveryMetadataFromNetwork",
		AuthorityUpdateCloudDiscoveryMetadata: "authorityUpdateCloudDiscoveryMetadata",
		AuthorityGetEndpointMetadataFromNetwork: "authorityGetEndpointMetadataFromNetwork",
		AuthorityUpdateEndpointMetadata: "authorityUpdateEndpointMetadata",
		AuthorityUpdateMetadataWithRegionalInformation: "authorityUpdateMetadataWithRegionalInformation",
		/**
		* Region Discovery functions
		*/
		RegionDiscoveryDetectRegion: "regionDiscoveryDetectRegion",
		RegionDiscoveryGetRegionFromIMDS: "regionDiscoveryGetRegionFromIMDS",
		RegionDiscoveryGetCurrentVersion: "regionDiscoveryGetCurrentVersion",
		AcquireTokenByCodeAsync: "acquireTokenByCodeAsync",
		GetEndpointMetadataFromNetwork: "getEndpointMetadataFromNetwork",
		GetCloudDiscoveryMetadataFromNetworkMeasurement: "getCloudDiscoveryMetadataFromNetworkMeasurement",
		HandleRedirectPromiseMeasurement: "handleRedirectPromise",
		HandleNativeRedirectPromiseMeasurement: "handleNativeRedirectPromise",
		UpdateCloudDiscoveryMetadataMeasurement: "updateCloudDiscoveryMetadataMeasurement",
		UsernamePasswordClientAcquireToken: "usernamePasswordClientAcquireToken",
		NativeMessageHandlerHandshake: "nativeMessageHandlerHandshake",
		NativeGenerateAuthResult: "nativeGenerateAuthResult",
		RemoveHiddenIframe: "removeHiddenIframe",
		/**
		* Cache operations
		*/
		ClearTokensAndKeysWithClaims: "clearTokensAndKeysWithClaims",
		CacheManagerGetRefreshToken: "cacheManagerGetRefreshToken",
		ImportExistingCache: "importExistingCache",
		SetUserData: "setUserData",
		LocalStorageUpdated: "localStorageUpdated",
		/**
		* Crypto Operations
		*/
		GeneratePkceCodes: "generatePkceCodes",
		GenerateCodeVerifier: "generateCodeVerifier",
		GenerateCodeChallengeFromVerifier: "generateCodeChallengeFromVerifier",
		Sha256Digest: "sha256Digest",
		GetRandomValues: "getRandomValues",
		GenerateHKDF: "generateHKDF",
		GenerateBaseKey: "generateBaseKey",
		Base64Decode: "base64Decode",
		UrlEncodeArr: "urlEncodeArr",
		Encrypt: "encrypt",
		Decrypt: "decrypt",
		GenerateEarKey: "generateEarKey",
		DecryptEarResponse: "decryptEarResponse",
		LoadExternalTokens: "LoadExternalTokens",
		LoadAccount: "loadAccount",
		LoadIdToken: "loadIdToken",
		LoadAccessToken: "loadAccessToken",
		LoadRefreshToken: "loadRefreshToken",
		/**
		* SSO capability verification call (msal-browser).
		* Fire-and-forget SSO verification call made after interactive authentication completes.
		*/
		SsoCapable: "ssoCapable"
	};
	const PerformanceEventAbbreviations = new Map([
		[PerformanceEvents.AcquireTokenByCode, "ATByCode"],
		[PerformanceEvents.AcquireTokenByRefreshToken, "ATByRT"],
		[PerformanceEvents.AcquireTokenSilent, "ATS"],
		[PerformanceEvents.AcquireTokenSilentAsync, "ATSAsync"],
		[PerformanceEvents.AcquireTokenPopup, "ATPopup"],
		[PerformanceEvents.AcquireTokenRedirect, "ATRedirect"],
		[PerformanceEvents.CryptoOptsGetPublicKeyThumbprint, "CryptoGetPKThumb"],
		[PerformanceEvents.CryptoOptsSignJwt, "CryptoSignJwt"],
		[PerformanceEvents.SilentCacheClientAcquireToken, "SltCacheClientAT"],
		[PerformanceEvents.SilentIframeClientAcquireToken, "SltIframeClientAT"],
		[PerformanceEvents.SilentRefreshClientAcquireToken, "SltRClientAT"],
		[PerformanceEvents.SsoSilent, "SsoSlt"],
		[PerformanceEvents.StandardInteractionClientGetDiscoveredAuthority, "StdIntClientGetDiscAuth"],
		[PerformanceEvents.FetchAccountIdWithNativeBroker, "FetchAccIdWithNtvBroker"],
		[PerformanceEvents.NativeInteractionClientAcquireToken, "NtvIntClientAT"],
		[PerformanceEvents.BaseClientCreateTokenRequestHeaders, "BaseClientCreateTReqHead"],
		[PerformanceEvents.NetworkClientSendPostRequestAsync, "NetClientSendPost"],
		[PerformanceEvents.RefreshTokenClientExecutePostToTokenEndpoint, "RTClientExecPost"],
		[PerformanceEvents.AuthorizationCodeClientExecutePostToTokenEndpoint, "AuthCodeClientExecPost"],
		[PerformanceEvents.BrokerHandhshake, "BrokerHandshake"],
		[PerformanceEvents.AcquireTokenByRefreshTokenInBroker, "ATByRTInBroker"],
		[PerformanceEvents.AcquireTokenByBroker, "ATByBroker"],
		[PerformanceEvents.RefreshTokenClientExecuteTokenRequest, "RTClientExecTReq"],
		[PerformanceEvents.RefreshTokenClientAcquireToken, "RTClientAT"],
		[PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, "RTClientATWithCachedRT"],
		[PerformanceEvents.RefreshTokenClientAcquireTokenByRefreshToken, "RTClientATByRT"],
		[PerformanceEvents.RefreshTokenClientCreateTokenRequestBody, "RTClientCreateTReqBody"],
		[PerformanceEvents.AcquireTokenFromCache, "ATFromCache"],
		[PerformanceEvents.SilentFlowClientAcquireCachedToken, "SltFlowClientATCached"],
		[PerformanceEvents.SilentFlowClientGenerateResultFromCacheRecord, "SltFlowClientGenResFromCache"],
		[PerformanceEvents.AcquireTokenBySilentIframe, "ATBySltIframe"],
		[PerformanceEvents.InitializeBaseRequest, "InitBaseReq"],
		[PerformanceEvents.InitializeSilentRequest, "InitSltReq"],
		[PerformanceEvents.InitializeClientApplication, "InitClientApplication"],
		[PerformanceEvents.InitializeCache, "InitCache"],
		[PerformanceEvents.ImportExistingCache, "importCache"],
		[PerformanceEvents.SetUserData, "setUserData"],
		[PerformanceEvents.LocalStorageUpdated, "localStorageUpdated"],
		[PerformanceEvents.SilentIframeClientTokenHelper, "SIClientTHelper"],
		[PerformanceEvents.SilentHandlerInitiateAuthRequest, "SHandlerInitAuthReq"],
		[PerformanceEvents.SilentHandlerMonitorIframeForHash, "SltHandlerMonitorIframeForHash"],
		[PerformanceEvents.SilentHandlerLoadFrame, "SHandlerLoadFrame"],
		[PerformanceEvents.SilentHandlerLoadFrameSync, "SHandlerLoadFrameSync"],
		[PerformanceEvents.StandardInteractionClientCreateAuthCodeClient, "StdIntClientCreateAuthCodeClient"],
		[PerformanceEvents.StandardInteractionClientGetClientConfiguration, "StdIntClientGetClientConf"],
		[PerformanceEvents.StandardInteractionClientInitializeAuthorizationRequest, "StdIntClientInitAuthReq"],
		[PerformanceEvents.GetAuthCodeUrl, "GetAuthCodeUrl"],
		[PerformanceEvents.HandleCodeResponseFromServer, "HandleCodeResFromServer"],
		[PerformanceEvents.HandleCodeResponse, "HandleCodeResp"],
		[PerformanceEvents.HandleResponseEar, "HandleRespEar"],
		[PerformanceEvents.HandleResponseCode, "HandleRespCode"],
		[PerformanceEvents.HandleResponsePlatformBroker, "HandleRespPlatBroker"],
		[PerformanceEvents.UpdateTokenEndpointAuthority, "UpdTEndpointAuth"],
		[PerformanceEvents.AuthClientAcquireToken, "AuthClientAT"],
		[PerformanceEvents.AuthClientExecuteTokenRequest, "AuthClientExecTReq"],
		[PerformanceEvents.AuthClientCreateTokenRequestBody, "AuthClientCreateTReqBody"],
		[PerformanceEvents.PopTokenGenerateCnf, "PopTGenCnf"],
		[PerformanceEvents.PopTokenGenerateKid, "PopTGenKid"],
		[PerformanceEvents.HandleServerTokenResponse, "HandleServerTRes"],
		[PerformanceEvents.DeserializeResponse, "DeserializeRes"],
		[PerformanceEvents.AuthorityFactoryCreateDiscoveredInstance, "AuthFactCreateDiscInst"],
		[PerformanceEvents.AuthorityResolveEndpointsAsync, "AuthResolveEndpointsAsync"],
		[PerformanceEvents.AuthorityResolveEndpointsFromLocalSources, "AuthResolveEndpointsFromLocal"],
		[PerformanceEvents.AuthorityGetCloudDiscoveryMetadataFromNetwork, "AuthGetCDMetaFromNet"],
		[PerformanceEvents.AuthorityUpdateCloudDiscoveryMetadata, "AuthUpdCDMeta"],
		[PerformanceEvents.AuthorityGetEndpointMetadataFromNetwork, "AuthUpdCDMetaFromNet"],
		[PerformanceEvents.AuthorityUpdateEndpointMetadata, "AuthUpdEndpointMeta"],
		[PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, "AuthUpdMetaWithRegInfo"],
		[PerformanceEvents.RegionDiscoveryDetectRegion, "RegDiscDetectReg"],
		[PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, "RegDiscGetRegFromIMDS"],
		[PerformanceEvents.RegionDiscoveryGetCurrentVersion, "RegDiscGetCurrentVer"],
		[PerformanceEvents.AcquireTokenByCodeAsync, "ATByCodeAsync"],
		[PerformanceEvents.GetEndpointMetadataFromNetwork, "GetEndpointMetaFromNet"],
		[PerformanceEvents.GetCloudDiscoveryMetadataFromNetworkMeasurement, "GetCDMetaFromNet"],
		[PerformanceEvents.HandleRedirectPromiseMeasurement, "HandleRedirectPromise"],
		[PerformanceEvents.HandleNativeRedirectPromiseMeasurement, "HandleNtvRedirectPromise"],
		[PerformanceEvents.UpdateCloudDiscoveryMetadataMeasurement, "UpdateCDMeta"],
		[PerformanceEvents.UsernamePasswordClientAcquireToken, "UserPassClientAT"],
		[PerformanceEvents.NativeMessageHandlerHandshake, "NtvMsgHandlerHandshake"],
		[PerformanceEvents.NativeGenerateAuthResult, "NtvGenAuthRes"],
		[PerformanceEvents.RemoveHiddenIframe, "RemoveHiddenIframe"],
		[PerformanceEvents.ClearTokensAndKeysWithClaims, "ClearTAndKeysWithClaims"],
		[PerformanceEvents.CacheManagerGetRefreshToken, "CacheManagerGetRT"],
		[PerformanceEvents.GeneratePkceCodes, "GenPkceCodes"],
		[PerformanceEvents.GenerateCodeVerifier, "GenCodeVerifier"],
		[PerformanceEvents.GenerateCodeChallengeFromVerifier, "GenCodeChallengeFromVerifier"],
		[PerformanceEvents.Sha256Digest, "Sha256Digest"],
		[PerformanceEvents.GetRandomValues, "GetRandomValues"],
		[PerformanceEvents.GenerateHKDF, "genHKDF"],
		[PerformanceEvents.GenerateBaseKey, "genBaseKey"],
		[PerformanceEvents.Base64Decode, "b64Decode"],
		[PerformanceEvents.UrlEncodeArr, "urlEncArr"],
		[PerformanceEvents.Encrypt, "encrypt"],
		[PerformanceEvents.Decrypt, "decrypt"],
		[PerformanceEvents.GenerateEarKey, "genEarKey"],
		[PerformanceEvents.DecryptEarResponse, "decryptEarResp"],
		[PerformanceEvents.SsoCapable, "SsoCapable"]
	]);
	/**
	* State of the performance event.
	*
	* @export
	* @enum {number}
	*/
	const PerformanceEventStatus = {
		NotStarted: 0,
		InProgress: 1,
		Completed: 2
	};
	const IntFields = new Set([
		"accessTokenSize",
		"durationMs",
		"idTokenSize",
		"matsSilentStatus",
		"matsHttpStatus",
		"refreshTokenSize",
		"queuedTimeMs",
		"startTimeMs",
		"status",
		"multiMatchedAT",
		"multiMatchedID",
		"multiMatchedRT",
		"unencryptedCacheCount",
		"encryptedCacheExpiredCount",
		"oldAccountCount",
		"oldAccessCount",
		"oldIdCount",
		"oldRefreshCount",
		"currAccountCount",
		"currAccessCount",
		"currIdCount",
		"currRefreshCount",
		"expiredCacheRemovedCount",
		"upgradedCacheCount",
		"networkRtt",
		"iframePollIntervalMs",
		"iframeTimeoutMs",
		"iframeTickCount",
		"crossOriginTickCount"
	]);
	/**
	* Wraps a function with a performance measurement.
	* Usage: invoke(functionToCall, performanceClient, "EventName", "correlationId")(...argsToPassToFunction)
	* @param callback
	* @param eventName
	* @param logger
	* @param telemetryClient
	* @param correlationId
	* @returns
	* @internal
	*/
	const invoke = (callback, eventName, logger, telemetryClient, correlationId) => {
		return (...args) => {
			logger.trace(`Executing function ${eventName}`);
			const inProgressEvent = telemetryClient?.startMeasurement(eventName, correlationId);
			if (correlationId) {
				const eventCount = eventName + "CallCount";
				telemetryClient?.incrementFields({ [eventCount]: 1 }, correlationId);
			}
			try {
				const result = callback(...args);
				inProgressEvent?.end({ success: true });
				logger.trace(`Returning result from ${eventName}`);
				return result;
			} catch (e) {
				logger.trace(`Error occurred in ${eventName}`);
				try {
					logger.trace(JSON.stringify(e));
				} catch (e) {
					logger.trace("Unable to print error message.");
				}
				inProgressEvent?.end({ success: false }, e);
				throw e;
			}
		};
	};
	/**
	* Wraps an async function with a performance measurement.
	* Usage: invokeAsync(functionToCall, performanceClient, "EventName", "correlationId")(...argsToPassToFunction)
	* @param callback
	* @param eventName
	* @param logger
	* @param telemetryClient
	* @param correlationId
	* @returns
	* @internal
	*
	*/
	const invokeAsync = (callback, eventName, logger, telemetryClient, correlationId) => {
		return (...args) => {
			logger.trace(`Executing function ${eventName}`);
			const inProgressEvent = telemetryClient?.startMeasurement(eventName, correlationId);
			if (correlationId) {
				const eventCount = eventName + "CallCount";
				telemetryClient?.incrementFields({ [eventCount]: 1 }, correlationId);
			}
			telemetryClient?.setPreQueueTime(eventName, correlationId);
			return callback(...args).then((response) => {
				logger.trace(`Returning result from ${eventName}`);
				inProgressEvent?.end({ success: true });
				return response;
			}).catch((e) => {
				logger.trace(`Error occurred in ${eventName}`);
				try {
					logger.trace(JSON.stringify(e));
				} catch (e) {
					logger.trace("Unable to print error message.");
				}
				inProgressEvent?.end({ success: false }, e);
				throw e;
			});
		};
	};
	var RegionDiscovery = class RegionDiscovery {
		constructor(networkInterface, logger, performanceClient, correlationId) {
			this.networkInterface = networkInterface;
			this.logger = logger;
			this.performanceClient = performanceClient;
			this.correlationId = correlationId;
		}
		/**
		* Detect the region from the application's environment.
		*
		* @returns Promise<string | null>
		*/
		async detectRegion(environmentRegion, regionDiscoveryMetadata) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryDetectRegion, this.correlationId);
			let autodetectedRegionName = environmentRegion;
			if (!autodetectedRegionName) {
				const options = RegionDiscovery.IMDS_OPTIONS;
				try {
					const localIMDSVersionResponse = await invokeAsync(this.getRegionFromIMDS.bind(this), PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.logger, this.performanceClient, this.correlationId)(Constants.IMDS_VERSION, options);
					if (localIMDSVersionResponse.status === HttpStatus.SUCCESS) {
						autodetectedRegionName = localIMDSVersionResponse.body;
						regionDiscoveryMetadata.region_source = RegionDiscoverySources.IMDS;
					}
					if (localIMDSVersionResponse.status === HttpStatus.BAD_REQUEST) {
						const currentIMDSVersion = await invokeAsync(this.getCurrentVersion.bind(this), PerformanceEvents.RegionDiscoveryGetCurrentVersion, this.logger, this.performanceClient, this.correlationId)(options);
						if (!currentIMDSVersion) {
							regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
							return null;
						}
						const currentIMDSVersionResponse = await invokeAsync(this.getRegionFromIMDS.bind(this), PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.logger, this.performanceClient, this.correlationId)(currentIMDSVersion, options);
						if (currentIMDSVersionResponse.status === HttpStatus.SUCCESS) {
							autodetectedRegionName = currentIMDSVersionResponse.body;
							regionDiscoveryMetadata.region_source = RegionDiscoverySources.IMDS;
						}
					}
				} catch (e) {
					regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
					return null;
				}
			} else regionDiscoveryMetadata.region_source = RegionDiscoverySources.ENVIRONMENT_VARIABLE;
			if (!autodetectedRegionName) regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
			return autodetectedRegionName || null;
		}
		/**
		* Make the call to the IMDS endpoint
		*
		* @param imdsEndpointUrl
		* @returns Promise<NetworkResponse<string>>
		*/
		async getRegionFromIMDS(version, options) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.correlationId);
			return this.networkInterface.sendGetRequestAsync(`${Constants.IMDS_ENDPOINT}?api-version=${version}&format=text`, options, Constants.IMDS_TIMEOUT);
		}
		/**
		* Get the most recent version of the IMDS endpoint available
		*
		* @returns Promise<string | null>
		*/
		async getCurrentVersion(options) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryGetCurrentVersion, this.correlationId);
			try {
				const response = await this.networkInterface.sendGetRequestAsync(`${Constants.IMDS_ENDPOINT}?format=json`, options);
				if (response.status === HttpStatus.BAD_REQUEST && response.body && response.body["newest-versions"] && response.body["newest-versions"].length > 0) return response.body["newest-versions"][0];
				return null;
			} catch (e) {
				return null;
			}
		}
	};
	RegionDiscovery.IMDS_OPTIONS = { headers: { Metadata: "true" } };
	/**
	* Utility functions for managing date and time operations.
	*/
	/**
	* return the current time in Unix time (seconds).
	*/
	function nowSeconds() {
		return Math.round((/* @__PURE__ */ new Date()).getTime() / 1e3);
	}
	/**
	* Converts JS Date object to seconds
	* @param date Date
	*/
	function toSecondsFromDate(date) {
		return date.getTime() / 1e3;
	}
	/**
	* Convert seconds to JS Date object. Seconds can be in a number or string format or undefined (will still return a date).
	* @param seconds
	*/
	function toDateFromSeconds(seconds) {
		if (seconds) return /* @__PURE__ */ new Date(Number(seconds) * 1e3);
		return /* @__PURE__ */ new Date();
	}
	/**
	* check if a token is expired based on given UTC time in seconds.
	* @param expiresOn
	*/
	function isTokenExpired(expiresOn, offset) {
		const expirationSec = Number(expiresOn) || 0;
		return nowSeconds() + offset > expirationSec;
	}
	/**
	* Checks if a cache entry is expired based on the last updated time and cache retention days.
	* @param lastUpdatedAt
	* @param cacheRetentionDays
	* @returns
	*/
	function isCacheExpired(lastUpdatedAt, cacheRetentionDays) {
		const cacheExpirationTimestamp = Number(lastUpdatedAt) + cacheRetentionDays * 24 * 60 * 60 * 1e3;
		return Date.now() > cacheExpirationTimestamp;
	}
	/**
	* If the current time is earlier than the time that a token was cached at, we must discard the token
	* i.e. The system clock was turned back after acquiring the cached token
	* @param cachedAt
	* @param offset
	*/
	function wasClockTurnedBack(cachedAt) {
		return Number(cachedAt) > nowSeconds();
	}
	/**
	* Waits for t number of milliseconds
	* @param t number
	* @param value T
	*/
	function delay(t, value) {
		return new Promise((resolve) => setTimeout(() => resolve(value), t));
	}
	var TimeUtils = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		delay,
		isCacheExpired,
		isTokenExpired,
		nowSeconds,
		toDateFromSeconds,
		toSecondsFromDate,
		wasClockTurnedBack
	});
	/**
	* Create IdTokenEntity
	* @param homeAccountId
	* @param authenticationResult
	* @param clientId
	* @param authority
	*/
	function createIdTokenEntity(homeAccountId, environment, idToken, clientId, tenantId) {
		return {
			credentialType: CredentialType.ID_TOKEN,
			homeAccountId,
			environment,
			clientId,
			secret: idToken,
			realm: tenantId,
			lastUpdatedAt: Date.now().toString()
		};
	}
	/**
	* Create AccessTokenEntity
	* @param homeAccountId
	* @param environment
	* @param accessToken
	* @param clientId
	* @param tenantId
	* @param scopes
	* @param expiresOn
	* @param extExpiresOn
	*/
	function createAccessTokenEntity(homeAccountId, environment, accessToken, clientId, tenantId, scopes, expiresOn, extExpiresOn, base64Decode, refreshOn, tokenType, userAssertionHash, keyId, requestedClaims, requestedClaimsHash) {
		const atEntity = {
			homeAccountId,
			credentialType: CredentialType.ACCESS_TOKEN,
			secret: accessToken,
			cachedAt: nowSeconds().toString(),
			expiresOn: expiresOn.toString(),
			extendedExpiresOn: extExpiresOn.toString(),
			environment,
			clientId,
			realm: tenantId,
			target: scopes,
			tokenType: tokenType || AuthenticationScheme.BEARER,
			lastUpdatedAt: Date.now().toString()
		};
		if (userAssertionHash) atEntity.userAssertionHash = userAssertionHash;
		if (refreshOn) atEntity.refreshOn = refreshOn.toString();
		if (requestedClaims) {
			atEntity.requestedClaims = requestedClaims;
			atEntity.requestedClaimsHash = requestedClaimsHash;
		}
		if (atEntity.tokenType?.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase()) {
			atEntity.credentialType = CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME;
			switch (atEntity.tokenType) {
				case AuthenticationScheme.POP:
					const tokenClaims = extractTokenClaims(accessToken, base64Decode);
					if (!tokenClaims?.cnf?.kid) throw createClientAuthError(tokenClaimsCnfRequiredForSignedJwt);
					atEntity.keyId = tokenClaims.cnf.kid;
					break;
				case AuthenticationScheme.SSH: atEntity.keyId = keyId;
			}
		}
		return atEntity;
	}
	/**
	* Create RefreshTokenEntity
	* @param homeAccountId
	* @param authenticationResult
	* @param clientId
	* @param authority
	*/
	function createRefreshTokenEntity(homeAccountId, environment, refreshToken, clientId, familyId, userAssertionHash, expiresOn) {
		const rtEntity = {
			credentialType: CredentialType.REFRESH_TOKEN,
			homeAccountId,
			environment,
			clientId,
			secret: refreshToken,
			lastUpdatedAt: Date.now().toString()
		};
		if (userAssertionHash) rtEntity.userAssertionHash = userAssertionHash;
		if (familyId) rtEntity.familyId = familyId;
		if (expiresOn) rtEntity.expiresOn = expiresOn.toString();
		return rtEntity;
	}
	function isCredentialEntity(entity) {
		return entity.hasOwnProperty("homeAccountId") && entity.hasOwnProperty("environment") && entity.hasOwnProperty("credentialType") && entity.hasOwnProperty("clientId") && entity.hasOwnProperty("secret");
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isAccessTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity.hasOwnProperty("realm") && entity.hasOwnProperty("target") && (entity["credentialType"] === CredentialType.ACCESS_TOKEN || entity["credentialType"] === CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME);
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isIdTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity.hasOwnProperty("realm") && entity["credentialType"] === CredentialType.ID_TOKEN;
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isRefreshTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity["credentialType"] === CredentialType.REFRESH_TOKEN;
	}
	/**
	* validates if a given cache entry is "Telemetry", parses <key,value>
	* @param key
	* @param entity
	*/
	function isServerTelemetryEntity(key, entity) {
		const validateKey = key.indexOf(SERVER_TELEM_CONSTANTS.CACHE_KEY) === 0;
		let validateEntity = true;
		if (entity) validateEntity = entity.hasOwnProperty("failedRequests") && entity.hasOwnProperty("errors") && entity.hasOwnProperty("cacheHits");
		return validateKey && validateEntity;
	}
	/**
	* validates if a given cache entry is "Throttling", parses <key,value>
	* @param key
	* @param entity
	*/
	function isThrottlingEntity(key, entity) {
		let validateKey = false;
		if (key) validateKey = key.indexOf(ThrottlingConstants.THROTTLING_PREFIX) === 0;
		let validateEntity = true;
		if (entity) validateEntity = entity.hasOwnProperty("throttleTime");
		return validateKey && validateEntity;
	}
	/**
	* Generate AppMetadata Cache Key as per the schema: appmetadata-<environment>-<client_id>
	*/
	function generateAppMetadataKey({ environment, clientId }) {
		return [
			APP_METADATA,
			environment,
			clientId
		].join(Separators.CACHE_KEY_SEPARATOR).toLowerCase();
	}
	function isAppMetadataEntity(key, entity) {
		if (!entity) return false;
		return key.indexOf(APP_METADATA) === 0 && entity.hasOwnProperty("clientId") && entity.hasOwnProperty("environment");
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isAuthorityMetadataEntity(key, entity) {
		if (!entity) return false;
		return key.indexOf(AUTHORITY_METADATA_CONSTANTS.CACHE_KEY) === 0 && entity.hasOwnProperty("aliases") && entity.hasOwnProperty("preferred_cache") && entity.hasOwnProperty("preferred_network") && entity.hasOwnProperty("canonical_authority") && entity.hasOwnProperty("authorization_endpoint") && entity.hasOwnProperty("token_endpoint") && entity.hasOwnProperty("issuer") && entity.hasOwnProperty("aliasesFromNetwork") && entity.hasOwnProperty("endpointsFromNetwork") && entity.hasOwnProperty("expiresAt") && entity.hasOwnProperty("jwks_uri");
	}
	/**
	* Reset the exiresAt value
	*/
	function generateAuthorityMetadataExpiresAt() {
		return nowSeconds() + AUTHORITY_METADATA_CONSTANTS.REFRESH_TIME_SECONDS;
	}
	function updateAuthorityEndpointMetadata(authorityMetadata, updatedValues, fromNetwork) {
		authorityMetadata.authorization_endpoint = updatedValues.authorization_endpoint;
		authorityMetadata.token_endpoint = updatedValues.token_endpoint;
		authorityMetadata.end_session_endpoint = updatedValues.end_session_endpoint;
		authorityMetadata.issuer = updatedValues.issuer;
		authorityMetadata.endpointsFromNetwork = fromNetwork;
		authorityMetadata.jwks_uri = updatedValues.jwks_uri;
	}
	function updateCloudDiscoveryMetadata(authorityMetadata, updatedValues, fromNetwork) {
		authorityMetadata.aliases = updatedValues.aliases;
		authorityMetadata.preferred_cache = updatedValues.preferred_cache;
		authorityMetadata.preferred_network = updatedValues.preferred_network;
		authorityMetadata.aliasesFromNetwork = fromNetwork;
	}
	/**
	* Returns whether or not the data needs to be refreshed
	*/
	function isAuthorityMetadataExpired(metadata) {
		return metadata.expiresAt <= nowSeconds();
	}
	var CacheHelpers = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		createAccessTokenEntity,
		createIdTokenEntity,
		createRefreshTokenEntity,
		generateAppMetadataKey,
		generateAuthorityMetadataExpiresAt,
		isAccessTokenEntity,
		isAppMetadataEntity,
		isAuthorityMetadataEntity,
		isAuthorityMetadataExpired,
		isCredentialEntity,
		isIdTokenEntity,
		isRefreshTokenEntity,
		isServerTelemetryEntity,
		isThrottlingEntity,
		updateAuthorityEndpointMetadata,
		updateCloudDiscoveryMetadata
	});
	/**
	* The authority class validates the authority URIs used by the user, and retrieves the OpenID Configuration Data from the
	* endpoint. It will store the pertinent config data in this object for use during token calls.
	* @internal
	*/
	var Authority = class Authority {
		constructor(authority, networkInterface, cacheManager, authorityOptions, logger, correlationId, performanceClient, managedIdentity) {
			this.canonicalAuthority = authority;
			this._canonicalAuthority.validateAsUri();
			this.networkInterface = networkInterface;
			this.cacheManager = cacheManager;
			this.authorityOptions = authorityOptions;
			this.regionDiscoveryMetadata = {
				region_used: void 0,
				region_source: void 0,
				region_outcome: void 0
			};
			this.logger = logger;
			this.performanceClient = performanceClient;
			this.correlationId = correlationId;
			this.managedIdentity = managedIdentity || false;
			this.regionDiscovery = new RegionDiscovery(networkInterface, this.logger, this.performanceClient, this.correlationId);
		}
		/**
		* Get {@link AuthorityType}
		* @param authorityUri {@link IUri}
		* @private
		*/
		getAuthorityType(authorityUri) {
			if (authorityUri.HostNameAndPort.endsWith(Constants.CIAM_AUTH_URL)) return AuthorityType.Ciam;
			const pathSegments = authorityUri.PathSegments;
			if (pathSegments.length) switch (pathSegments[0].toLowerCase()) {
				case Constants.ADFS: return AuthorityType.Adfs;
				case Constants.DSTS: return AuthorityType.Dsts;
			}
			return AuthorityType.Default;
		}
		get authorityType() {
			return this.getAuthorityType(this.canonicalAuthorityUrlComponents);
		}
		/**
		* ProtocolMode enum representing the way endpoints are constructed.
		*/
		get protocolMode() {
			return this.authorityOptions.protocolMode;
		}
		/**
		* Returns authorityOptions which can be used to reinstantiate a new authority instance
		*/
		get options() {
			return this.authorityOptions;
		}
		/**
		* A URL that is the authority set by the developer
		*/
		get canonicalAuthority() {
			return this._canonicalAuthority.urlString;
		}
		/**
		* Sets canonical authority.
		*/
		set canonicalAuthority(url) {
			this._canonicalAuthority = new UrlString(url);
			this._canonicalAuthority.validateAsUri();
			this._canonicalAuthorityUrlComponents = null;
		}
		/**
		* Get authority components.
		*/
		get canonicalAuthorityUrlComponents() {
			if (!this._canonicalAuthorityUrlComponents) this._canonicalAuthorityUrlComponents = this._canonicalAuthority.getUrlComponents();
			return this._canonicalAuthorityUrlComponents;
		}
		/**
		* Get hostname and port i.e. login.microsoftonline.com
		*/
		get hostnameAndPort() {
			return this.canonicalAuthorityUrlComponents.HostNameAndPort.toLowerCase();
		}
		/**
		* Get tenant for authority.
		*/
		get tenant() {
			return this.canonicalAuthorityUrlComponents.PathSegments[0];
		}
		/**
		* OAuth /authorize endpoint for requests
		*/
		get authorizationEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.authorization_endpoint);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth /token endpoint for requests
		*/
		get tokenEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.token_endpoint);
			else throw createClientAuthError(endpointResolutionError);
		}
		get deviceCodeEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.token_endpoint.replace("/token", "/devicecode"));
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth logout endpoint for requests
		*/
		get endSessionEndpoint() {
			if (this.discoveryComplete()) {
				if (!this.metadata.end_session_endpoint) throw createClientAuthError(endSessionEndpointNotSupported);
				return this.replacePath(this.metadata.end_session_endpoint);
			} else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth issuer for requests
		*/
		get selfSignedJwtAudience() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.issuer);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Jwks_uri for token signing keys
		*/
		get jwksUri() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.jwks_uri);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Returns a flag indicating that tenant name can be replaced in authority {@link IUri}
		* @param authorityUri {@link IUri}
		* @private
		*/
		canReplaceTenant(authorityUri) {
			return authorityUri.PathSegments.length === 1 && !Authority.reservedTenantDomains.has(authorityUri.PathSegments[0]) && this.getAuthorityType(authorityUri) === AuthorityType.Default && this.protocolMode !== ProtocolMode.OIDC;
		}
		/**
		* Replaces tenant in url path with current tenant. Defaults to common.
		* @param urlString
		*/
		replaceTenant(urlString) {
			return urlString.replace(/{tenant}|{tenantid}/g, this.tenant);
		}
		/**
		* Replaces path such as tenant or policy with the current tenant or policy.
		* @param urlString
		*/
		replacePath(urlString) {
			let endpoint = urlString;
			const cachedAuthorityUrlComponents = new UrlString(this.metadata.canonical_authority).getUrlComponents();
			const cachedAuthorityParts = cachedAuthorityUrlComponents.PathSegments;
			this.canonicalAuthorityUrlComponents.PathSegments.forEach((currentPart, index) => {
				let cachedPart = cachedAuthorityParts[index];
				if (index === 0 && this.canReplaceTenant(cachedAuthorityUrlComponents)) {
					const tenantId = new UrlString(this.metadata.authorization_endpoint).getUrlComponents().PathSegments[0];
					/**
					* Check if AAD canonical authority contains tenant domain name, for example "testdomain.onmicrosoft.com",
					* by comparing its first path segment to the corresponding authorization endpoint path segment, which is
					* always resolved with tenant id by OIDC.
					*/
					if (cachedPart !== tenantId) {
						this.logger.verbose(`Replacing tenant domain name ${cachedPart} with id ${tenantId}`);
						cachedPart = tenantId;
					}
				}
				if (currentPart !== cachedPart) endpoint = endpoint.replace(`/${cachedPart}/`, `/${currentPart}/`);
			});
			return this.replaceTenant(endpoint);
		}
		/**
		* The default open id configuration endpoint for any canonical authority.
		*/
		get defaultOpenIdConfigurationEndpoint() {
			const canonicalAuthorityHost = this.hostnameAndPort;
			if (this.canonicalAuthority.endsWith("v2.0/") || this.authorityType === AuthorityType.Adfs || this.protocolMode === ProtocolMode.OIDC && !this.isAliasOfKnownMicrosoftAuthority(canonicalAuthorityHost)) return `${this.canonicalAuthority}.well-known/openid-configuration`;
			return `${this.canonicalAuthority}v2.0/.well-known/openid-configuration`;
		}
		/**
		* Boolean that returns whether or not tenant discovery has been completed.
		*/
		discoveryComplete() {
			return !!this.metadata;
		}
		/**
		* Perform endpoint discovery to discover aliases, preferred_cache, preferred_network
		* and the /authorize, /token and logout endpoints.
		*/
		async resolveEndpointsAsync() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityResolveEndpointsAsync, this.correlationId);
			const metadataEntity = this.getCurrentMetadataEntity();
			const cloudDiscoverySource = await invokeAsync(this.updateCloudDiscoveryMetadata.bind(this), PerformanceEvents.AuthorityUpdateCloudDiscoveryMetadata, this.logger, this.performanceClient, this.correlationId)(metadataEntity);
			this.canonicalAuthority = this.canonicalAuthority.replace(this.hostnameAndPort, metadataEntity.preferred_network);
			const endpointSource = await invokeAsync(this.updateEndpointMetadata.bind(this), PerformanceEvents.AuthorityUpdateEndpointMetadata, this.logger, this.performanceClient, this.correlationId)(metadataEntity);
			this.updateCachedMetadata(metadataEntity, cloudDiscoverySource, { source: endpointSource });
			this.performanceClient?.addFields({
				cloudDiscoverySource,
				authorityEndpointSource: endpointSource
			}, this.correlationId);
		}
		/**
		* Returns metadata entity from cache if it exists, otherwiser returns a new metadata entity built
		* from the configured canonical authority
		* @returns
		*/
		getCurrentMetadataEntity() {
			let metadataEntity = this.cacheManager.getAuthorityMetadataByAlias(this.hostnameAndPort);
			if (!metadataEntity) metadataEntity = {
				aliases: [],
				preferred_cache: this.hostnameAndPort,
				preferred_network: this.hostnameAndPort,
				canonical_authority: this.canonicalAuthority,
				authorization_endpoint: "",
				token_endpoint: "",
				end_session_endpoint: "",
				issuer: "",
				aliasesFromNetwork: false,
				endpointsFromNetwork: false,
				expiresAt: generateAuthorityMetadataExpiresAt(),
				jwks_uri: ""
			};
			return metadataEntity;
		}
		/**
		* Updates cached metadata based on metadata source and sets the instance's metadata
		* property to the same value
		* @param metadataEntity
		* @param cloudDiscoverySource
		* @param endpointMetadataResult
		*/
		updateCachedMetadata(metadataEntity, cloudDiscoverySource, endpointMetadataResult) {
			if (cloudDiscoverySource !== AuthorityMetadataSource.CACHE && endpointMetadataResult?.source !== AuthorityMetadataSource.CACHE) {
				metadataEntity.expiresAt = generateAuthorityMetadataExpiresAt();
				metadataEntity.canonical_authority = this.canonicalAuthority;
			}
			const cacheKey = this.cacheManager.generateAuthorityMetadataCacheKey(metadataEntity.preferred_cache);
			this.cacheManager.setAuthorityMetadata(cacheKey, metadataEntity);
			this.metadata = metadataEntity;
		}
		/**
		* Update AuthorityMetadataEntity with new endpoints and return where the information came from
		* @param metadataEntity
		*/
		async updateEndpointMetadata(metadataEntity) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateEndpointMetadata, this.correlationId);
			const localMetadata = this.updateEndpointMetadataFromLocalSources(metadataEntity);
			if (localMetadata) {
				if (localMetadata.source === AuthorityMetadataSource.HARDCODED_VALUES) {
					if (this.authorityOptions.azureRegionConfiguration?.azureRegion) {
						if (localMetadata.metadata) {
							updateAuthorityEndpointMetadata(metadataEntity, await invokeAsync(this.updateMetadataWithRegionalInformation.bind(this), PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.logger, this.performanceClient, this.correlationId)(localMetadata.metadata), false);
							metadataEntity.canonical_authority = this.canonicalAuthority;
						}
					}
				}
				return localMetadata.source;
			}
			let metadata = await invokeAsync(this.getEndpointMetadataFromNetwork.bind(this), PerformanceEvents.AuthorityGetEndpointMetadataFromNetwork, this.logger, this.performanceClient, this.correlationId)();
			if (metadata) {
				if (this.authorityOptions.azureRegionConfiguration?.azureRegion) metadata = await invokeAsync(this.updateMetadataWithRegionalInformation.bind(this), PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.logger, this.performanceClient, this.correlationId)(metadata);
				updateAuthorityEndpointMetadata(metadataEntity, metadata, true);
				return AuthorityMetadataSource.NETWORK;
			} else throw createClientAuthError(openIdConfigError, this.defaultOpenIdConfigurationEndpoint);
		}
		/**
		* Updates endpoint metadata from local sources and returns where the information was retrieved from and the metadata config
		* response if the source is hardcoded metadata
		* @param metadataEntity
		* @returns
		*/
		updateEndpointMetadataFromLocalSources(metadataEntity) {
			this.logger.verbose("Attempting to get endpoint metadata from authority configuration");
			const configMetadata = this.getEndpointMetadataFromConfig();
			if (configMetadata) {
				this.logger.verbose("Found endpoint metadata in authority configuration");
				updateAuthorityEndpointMetadata(metadataEntity, configMetadata, false);
				return { source: AuthorityMetadataSource.CONFIG };
			}
			this.logger.verbose("Did not find endpoint metadata in the config... Attempting to get endpoint metadata from the hardcoded values.");
			if (this.authorityOptions.skipAuthorityMetadataCache) this.logger.verbose("Skipping hardcoded metadata cache since skipAuthorityMetadataCache is set to true. Attempting to get endpoint metadata from the network metadata cache.");
			else {
				const hardcodedMetadata = this.getEndpointMetadataFromHardcodedValues();
				if (hardcodedMetadata) {
					updateAuthorityEndpointMetadata(metadataEntity, hardcodedMetadata, false);
					return {
						source: AuthorityMetadataSource.HARDCODED_VALUES,
						metadata: hardcodedMetadata
					};
				} else this.logger.verbose("Did not find endpoint metadata in hardcoded values... Attempting to get endpoint metadata from the network metadata cache.");
			}
			const metadataEntityExpired = isAuthorityMetadataExpired(metadataEntity);
			if (this.isAuthoritySameType(metadataEntity) && metadataEntity.endpointsFromNetwork && !metadataEntityExpired) {
				this.logger.verbose("Found endpoint metadata in the cache.");
				return { source: AuthorityMetadataSource.CACHE };
			} else if (metadataEntityExpired) this.logger.verbose("The metadata entity is expired.");
			return null;
		}
		/**
		* Compares the number of url components after the domain to determine if the cached
		* authority metadata can be used for the requested authority. Protects against same domain different
		* authority such as login.microsoftonline.com/tenant and login.microsoftonline.com/tfp/tenant/policy
		* @param metadataEntity
		*/
		isAuthoritySameType(metadataEntity) {
			return new UrlString(metadataEntity.canonical_authority).getUrlComponents().PathSegments.length === this.canonicalAuthorityUrlComponents.PathSegments.length;
		}
		/**
		* Parse authorityMetadata config option
		*/
		getEndpointMetadataFromConfig() {
			if (this.authorityOptions.authorityMetadata) try {
				return JSON.parse(this.authorityOptions.authorityMetadata);
			} catch (e) {
				throw createClientConfigurationError(invalidAuthorityMetadata);
			}
			return null;
		}
		/**
		* Gets OAuth endpoints from the given OpenID configuration endpoint.
		*
		* @param hasHardcodedMetadata boolean
		*/
		async getEndpointMetadataFromNetwork() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityGetEndpointMetadataFromNetwork, this.correlationId);
			const options = {};
			const openIdConfigurationEndpoint = this.defaultOpenIdConfigurationEndpoint;
			this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: attempting to retrieve OAuth endpoints from ${openIdConfigurationEndpoint}`);
			try {
				const response = await this.networkInterface.sendGetRequestAsync(openIdConfigurationEndpoint, options);
				if (isOpenIdConfigResponse(response.body)) return response.body;
				else {
					this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: could not parse response as OpenID configuration`);
					return null;
				}
			} catch (e) {
				this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: ${e}`);
				return null;
			}
		}
		/**
		* Get OAuth endpoints for common authorities.
		*/
		getEndpointMetadataFromHardcodedValues() {
			if (this.hostnameAndPort in EndpointMetadata) return EndpointMetadata[this.hostnameAndPort];
			return null;
		}
		/**
		* Update the retrieved metadata with regional information.
		* User selected Azure region will be used if configured.
		*/
		async updateMetadataWithRegionalInformation(metadata) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.correlationId);
			const userConfiguredAzureRegion = this.authorityOptions.azureRegionConfiguration?.azureRegion;
			if (userConfiguredAzureRegion) {
				if (userConfiguredAzureRegion !== Constants.AZURE_REGION_AUTO_DISCOVER_FLAG) {
					this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.CONFIGURED_NO_AUTO_DETECTION;
					this.regionDiscoveryMetadata.region_used = userConfiguredAzureRegion;
					return Authority.replaceWithRegionalInformation(metadata, userConfiguredAzureRegion);
				}
				const autodetectedRegionName = await invokeAsync(this.regionDiscovery.detectRegion.bind(this.regionDiscovery), PerformanceEvents.RegionDiscoveryDetectRegion, this.logger, this.performanceClient, this.correlationId)(this.authorityOptions.azureRegionConfiguration?.environmentRegion, this.regionDiscoveryMetadata);
				if (autodetectedRegionName) {
					this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.AUTO_DETECTION_REQUESTED_SUCCESSFUL;
					this.regionDiscoveryMetadata.region_used = autodetectedRegionName;
					return Authority.replaceWithRegionalInformation(metadata, autodetectedRegionName);
				}
				this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.AUTO_DETECTION_REQUESTED_FAILED;
			}
			return metadata;
		}
		/**
		* Updates the AuthorityMetadataEntity with new aliases, preferred_network and preferred_cache
		* and returns where the information was retrieved from
		* @param metadataEntity
		* @returns AuthorityMetadataSource
		*/
		async updateCloudDiscoveryMetadata(metadataEntity) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateCloudDiscoveryMetadata, this.correlationId);
			const localMetadataSource = this.updateCloudDiscoveryMetadataFromLocalSources(metadataEntity);
			if (localMetadataSource) return localMetadataSource;
			const metadata = await invokeAsync(this.getCloudDiscoveryMetadataFromNetwork.bind(this), PerformanceEvents.AuthorityGetCloudDiscoveryMetadataFromNetwork, this.logger, this.performanceClient, this.correlationId)();
			if (metadata) {
				updateCloudDiscoveryMetadata(metadataEntity, metadata, true);
				return AuthorityMetadataSource.NETWORK;
			}
			throw createClientConfigurationError(untrustedAuthority);
		}
		updateCloudDiscoveryMetadataFromLocalSources(metadataEntity) {
			this.logger.verbose("Attempting to get cloud discovery metadata  from authority configuration");
			this.logger.verbosePii(`Known Authorities: ${this.authorityOptions.knownAuthorities || Constants.NOT_APPLICABLE}`);
			this.logger.verbosePii(`Authority Metadata: ${this.authorityOptions.authorityMetadata || Constants.NOT_APPLICABLE}`);
			this.logger.verbosePii(`Canonical Authority: ${metadataEntity.canonical_authority || Constants.NOT_APPLICABLE}`);
			const metadata = this.getCloudDiscoveryMetadataFromConfig();
			if (metadata) {
				this.logger.verbose("Found cloud discovery metadata in authority configuration");
				updateCloudDiscoveryMetadata(metadataEntity, metadata, false);
				return AuthorityMetadataSource.CONFIG;
			}
			this.logger.verbose("Did not find cloud discovery metadata in the config... Attempting to get cloud discovery metadata from the hardcoded values.");
			if (this.options.skipAuthorityMetadataCache) this.logger.verbose("Skipping hardcoded cloud discovery metadata cache since skipAuthorityMetadataCache is set to true. Attempting to get cloud discovery metadata from the network metadata cache.");
			else {
				const hardcodedMetadata = getCloudDiscoveryMetadataFromHardcodedValues(this.hostnameAndPort);
				if (hardcodedMetadata) {
					this.logger.verbose("Found cloud discovery metadata from hardcoded values.");
					updateCloudDiscoveryMetadata(metadataEntity, hardcodedMetadata, false);
					return AuthorityMetadataSource.HARDCODED_VALUES;
				}
				this.logger.verbose("Did not find cloud discovery metadata in hardcoded values... Attempting to get cloud discovery metadata from the network metadata cache.");
			}
			const metadataEntityExpired = isAuthorityMetadataExpired(metadataEntity);
			if (this.isAuthoritySameType(metadataEntity) && metadataEntity.aliasesFromNetwork && !metadataEntityExpired) {
				this.logger.verbose("Found cloud discovery metadata in the cache.");
				return AuthorityMetadataSource.CACHE;
			} else if (metadataEntityExpired) this.logger.verbose("The metadata entity is expired.");
			return null;
		}
		/**
		* Parse cloudDiscoveryMetadata config or check knownAuthorities
		*/
		getCloudDiscoveryMetadataFromConfig() {
			if (this.authorityType === AuthorityType.Ciam) {
				this.logger.verbose("CIAM authorities do not support cloud discovery metadata, generate the aliases from authority host.");
				return Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			if (this.authorityOptions.cloudDiscoveryMetadata) {
				this.logger.verbose("The cloud discovery metadata has been provided as a network response, in the config.");
				try {
					this.logger.verbose("Attempting to parse the cloud discovery metadata.");
					const metadata = getCloudDiscoveryMetadataFromNetworkResponse(JSON.parse(this.authorityOptions.cloudDiscoveryMetadata).metadata, this.hostnameAndPort);
					this.logger.verbose("Parsed the cloud discovery metadata.");
					if (metadata) {
						this.logger.verbose("There is returnable metadata attached to the parsed cloud discovery metadata.");
						return metadata;
					} else this.logger.verbose("There is no metadata attached to the parsed cloud discovery metadata.");
				} catch (e) {
					this.logger.verbose("Unable to parse the cloud discovery metadata. Throwing Invalid Cloud Discovery Metadata Error.");
					throw createClientConfigurationError(invalidCloudDiscoveryMetadata);
				}
			}
			if (this.isInKnownAuthorities()) {
				this.logger.verbose("The host is included in knownAuthorities. Creating new cloud discovery metadata from the host.");
				return Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			return null;
		}
		/**
		* Called to get metadata from network if CloudDiscoveryMetadata was not populated by config
		*
		* @param hasHardcodedMetadata boolean
		*/
		async getCloudDiscoveryMetadataFromNetwork() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityGetCloudDiscoveryMetadataFromNetwork, this.correlationId);
			const instanceDiscoveryEndpoint = `${Constants.AAD_INSTANCE_DISCOVERY_ENDPT}${this.canonicalAuthority}oauth2/v2.0/authorize`;
			const options = {};
			let match = null;
			try {
				const response = await this.networkInterface.sendGetRequestAsync(instanceDiscoveryEndpoint, options);
				let typedResponseBody;
				let metadata;
				if (isCloudInstanceDiscoveryResponse(response.body)) {
					typedResponseBody = response.body;
					metadata = typedResponseBody.metadata;
					this.logger.verbosePii(`tenant_discovery_endpoint is: ${typedResponseBody.tenant_discovery_endpoint}`);
				} else if (isCloudInstanceDiscoveryErrorResponse(response.body)) {
					this.logger.warning(`A CloudInstanceDiscoveryErrorResponse was returned. The cloud instance discovery network request's status code is: ${response.status}`);
					typedResponseBody = response.body;
					if (typedResponseBody.error === Constants.INVALID_INSTANCE) {
						this.logger.error("The CloudInstanceDiscoveryErrorResponse error is invalid_instance.");
						return null;
					}
					this.logger.warning(`The CloudInstanceDiscoveryErrorResponse error is ${typedResponseBody.error}`);
					this.logger.warning(`The CloudInstanceDiscoveryErrorResponse error description is ${typedResponseBody.error_description}`);
					this.logger.warning("Setting the value of the CloudInstanceDiscoveryMetadata (returned from the network) to []");
					metadata = [];
				} else {
					this.logger.error("AAD did not return a CloudInstanceDiscoveryResponse or CloudInstanceDiscoveryErrorResponse");
					return null;
				}
				this.logger.verbose("Attempting to find a match between the developer's authority and the CloudInstanceDiscoveryMetadata returned from the network request.");
				match = getCloudDiscoveryMetadataFromNetworkResponse(metadata, this.hostnameAndPort);
			} catch (error) {
				if (error instanceof AuthError) this.logger.error(`There was a network error while attempting to get the cloud discovery instance metadata.\nError: ${error.errorCode}\nError Description: ${error.errorMessage}`);
				else {
					const typedError = error;
					this.logger.error(`A non-MSALJS error was thrown while attempting to get the cloud instance discovery metadata.\nError: ${typedError.name}\nError Description: ${typedError.message}`);
				}
				return null;
			}
			if (!match) {
				this.logger.warning("The developer's authority was not found within the CloudInstanceDiscoveryMetadata returned from the network request.");
				this.logger.verbose("Creating custom Authority for custom domain scenario.");
				match = Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			return match;
		}
		/**
		* Helper function to determine if this host is included in the knownAuthorities config option
		*/
		isInKnownAuthorities() {
			return this.authorityOptions.knownAuthorities.filter((authority) => {
				return authority && UrlString.getDomainFromUrl(authority).toLowerCase() === this.hostnameAndPort;
			}).length > 0;
		}
		/**
		* helper function to populate the authority based on azureCloudOptions
		* @param authorityString
		* @param azureCloudOptions
		*/
		static generateAuthority(authorityString, azureCloudOptions) {
			let authorityAzureCloudInstance;
			if (azureCloudOptions && azureCloudOptions.azureCloudInstance !== AzureCloudInstance.None) {
				const tenant = azureCloudOptions.tenant ? azureCloudOptions.tenant : Constants.DEFAULT_COMMON_TENANT;
				authorityAzureCloudInstance = `${azureCloudOptions.azureCloudInstance}/${tenant}/`;
			}
			return authorityAzureCloudInstance ? authorityAzureCloudInstance : authorityString;
		}
		/**
		* Creates cloud discovery metadata object from a given host
		* @param host
		*/
		static createCloudDiscoveryMetadataFromHost(host) {
			return {
				preferred_network: host,
				preferred_cache: host,
				aliases: [host]
			};
		}
		/**
		* helper function to generate environment from authority object
		*/
		getPreferredCache() {
			if (this.managedIdentity) return Constants.DEFAULT_AUTHORITY_HOST;
			else if (this.discoveryComplete()) return this.metadata.preferred_cache;
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Returns whether or not the provided host is an alias of this authority instance
		* @param host
		*/
		isAlias(host) {
			return this.metadata.aliases.indexOf(host) > -1;
		}
		/**
		* Returns whether or not the provided host is an alias of a known Microsoft authority for purposes of endpoint discovery
		* @param host
		*/
		isAliasOfKnownMicrosoftAuthority(host) {
			return InstanceDiscoveryMetadataAliases.has(host);
		}
		/**
		* Checks whether the provided host is that of a public cloud authority
		*
		* @param authority string
		* @returns bool
		*/
		static isPublicCloudAuthority(host) {
			return Constants.KNOWN_PUBLIC_CLOUDS.indexOf(host) >= 0;
		}
		/**
		* Rebuild the authority string with the region
		*
		* @param host string
		* @param region string
		*/
		static buildRegionalAuthorityString(host, region, queryString) {
			const authorityUrlInstance = new UrlString(host);
			authorityUrlInstance.validateAsUri();
			const authorityUrlParts = authorityUrlInstance.getUrlComponents();
			let hostNameAndPort = `${region}.${authorityUrlParts.HostNameAndPort}`;
			if (this.isPublicCloudAuthority(authorityUrlParts.HostNameAndPort)) hostNameAndPort = `${region}.${Constants.REGIONAL_AUTH_PUBLIC_CLOUD_SUFFIX}`;
			const url = UrlString.constructAuthorityUriFromObject({
				...authorityUrlInstance.getUrlComponents(),
				HostNameAndPort: hostNameAndPort
			}).urlString;
			if (queryString) return `${url}?${queryString}`;
			return url;
		}
		/**
		* Replace the endpoints in the metadata object with their regional equivalents.
		*
		* @param metadata OpenIdConfigResponse
		* @param azureRegion string
		*/
		static replaceWithRegionalInformation(metadata, azureRegion) {
			const regionalMetadata = { ...metadata };
			regionalMetadata.authorization_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.authorization_endpoint, azureRegion);
			regionalMetadata.token_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.token_endpoint, azureRegion);
			if (regionalMetadata.end_session_endpoint) regionalMetadata.end_session_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.end_session_endpoint, azureRegion);
			return regionalMetadata;
		}
		/**
		* Transform CIAM_AUTHORIY as per the below rules:
		* If no path segments found and it is a CIAM authority (hostname ends with .ciamlogin.com), then transform it
		*
		* NOTE: The transformation path should go away once STS supports CIAM with the format: `tenantIdorDomain.ciamlogin.com`
		* `ciamlogin.com` can also change in the future and we should accommodate the same
		*
		* @param authority
		*/
		static transformCIAMAuthority(authority) {
			let ciamAuthority = authority;
			const authorityUrlComponents = new UrlString(authority).getUrlComponents();
			if (authorityUrlComponents.PathSegments.length === 0 && authorityUrlComponents.HostNameAndPort.endsWith(Constants.CIAM_AUTH_URL)) {
				const tenantIdOrDomain = authorityUrlComponents.HostNameAndPort.split(".")[0];
				ciamAuthority = `${ciamAuthority}${tenantIdOrDomain}${Constants.AAD_TENANT_DOMAIN_SUFFIX}`;
			}
			return ciamAuthority;
		}
	};
	Authority.reservedTenantDomains = new Set([
		"{tenant}",
		"{tenantid}",
		AADAuthorityConstants.COMMON,
		AADAuthorityConstants.CONSUMERS,
		AADAuthorityConstants.ORGANIZATIONS
	]);
	/**
	* Extract tenantId from authority
	*/
	function getTenantFromAuthorityString(authority) {
		/**
		* For credential matching purposes, tenantId is the last path segment of the authority URL:
		*  AAD Authority - domain/tenantId -> Credentials are cached with realm = tenantId
		*  B2C Authority - domain/{tenantId}?/.../policy -> Credentials are cached with realm = policy
		*  tenantId is downcased because B2C policies can have mixed case but tfp claim is downcased
		*
		* Note that we may not have any path segments in certain OIDC scenarios.
		*/
		const tenantId = new UrlString(authority).getUrlComponents().PathSegments.slice(-1)[0]?.toLowerCase();
		switch (tenantId) {
			case AADAuthorityConstants.COMMON:
			case AADAuthorityConstants.ORGANIZATIONS:
			case AADAuthorityConstants.CONSUMERS: return;
			default: return tenantId;
		}
	}
	function formatAuthorityUri(authorityUri) {
		return authorityUri.endsWith(Constants.FORWARD_SLASH) ? authorityUri : `${authorityUri}${Constants.FORWARD_SLASH}`;
	}
	function buildStaticAuthorityOptions(authOptions) {
		const rawCloudDiscoveryMetadata = authOptions.cloudDiscoveryMetadata;
		let cloudDiscoveryMetadata = void 0;
		if (rawCloudDiscoveryMetadata) try {
			cloudDiscoveryMetadata = JSON.parse(rawCloudDiscoveryMetadata);
		} catch (e) {
			throw createClientConfigurationError(invalidCloudDiscoveryMetadata);
		}
		return {
			canonicalAuthority: authOptions.authority ? formatAuthorityUri(authOptions.authority) : void 0,
			knownAuthorities: authOptions.knownAuthorities,
			cloudDiscoveryMetadata
		};
	}
	/**
	* Create an authority object of the correct type based on the url
	* Performs basic authority validation - checks to see if the authority is of a valid type (i.e. aad, b2c, adfs)
	*
	* Also performs endpoint discovery.
	*
	* @param authorityUri
	* @param networkClient
	* @param protocolMode
	* @internal
	*/
	async function createDiscoveredInstance(authorityUri, networkClient, cacheManager, authorityOptions, logger, correlationId, performanceClient) {
		performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityFactoryCreateDiscoveredInstance, correlationId);
		const acquireTokenAuthority = new Authority(Authority.transformCIAMAuthority(formatAuthorityUri(authorityUri)), networkClient, cacheManager, authorityOptions, logger, correlationId, performanceClient);
		try {
			await invokeAsync(acquireTokenAuthority.resolveEndpointsAsync.bind(acquireTokenAuthority), PerformanceEvents.AuthorityResolveEndpointsAsync, logger, performanceClient, correlationId)();
			return acquireTokenAuthority;
		} catch (e) {
			throw createClientAuthError(endpointResolutionError);
		}
	}
	var AuthorityFactory = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		createDiscoveredInstance
	});
	const CLIENT_ID = "client_id";
	const REDIRECT_URI = "redirect_uri";
	const RESPONSE_TYPE = "response_type";
	const RESPONSE_MODE = "response_mode";
	const GRANT_TYPE = "grant_type";
	const CLAIMS = "claims";
	const SCOPE = "scope";
	const ERROR = "error";
	const ERROR_DESCRIPTION = "error_description";
	const ACCESS_TOKEN = "access_token";
	const ID_TOKEN = "id_token";
	const REFRESH_TOKEN = "refresh_token";
	const EXPIRES_IN = "expires_in";
	const REFRESH_TOKEN_EXPIRES_IN = "refresh_token_expires_in";
	const STATE = "state";
	const NONCE = "nonce";
	const PROMPT = "prompt";
	const SESSION_STATE = "session_state";
	const CLIENT_INFO = "client_info";
	const CODE = "code";
	const CODE_CHALLENGE = "code_challenge";
	const CODE_CHALLENGE_METHOD = "code_challenge_method";
	const CODE_VERIFIER = "code_verifier";
	const CLIENT_REQUEST_ID = "client-request-id";
	const X_CLIENT_SKU = "x-client-SKU";
	const X_CLIENT_VER = "x-client-VER";
	const X_CLIENT_OS = "x-client-OS";
	const X_CLIENT_CPU = "x-client-CPU";
	const X_CLIENT_CURR_TELEM = "x-client-current-telemetry";
	const X_CLIENT_LAST_TELEM = "x-client-last-telemetry";
	const X_MS_LIB_CAPABILITY = "x-ms-lib-capability";
	const X_APP_NAME = "x-app-name";
	const X_APP_VER = "x-app-ver";
	const POST_LOGOUT_URI = "post_logout_redirect_uri";
	const ID_TOKEN_HINT = "id_token_hint";
	const DEVICE_CODE = "device_code";
	const CLIENT_SECRET = "client_secret";
	const CLIENT_ASSERTION = "client_assertion";
	const CLIENT_ASSERTION_TYPE = "client_assertion_type";
	const TOKEN_TYPE = "token_type";
	const REQ_CNF = "req_cnf";
	const OBO_ASSERTION = "assertion";
	const REQUESTED_TOKEN_USE = "requested_token_use";
	const ON_BEHALF_OF = "on_behalf_of";
	const FOCI = "foci";
	const CCS_HEADER = "X-AnchorMailbox";
	const RETURN_SPA_CODE = "return_spa_code";
	const NATIVE_BROKER = "nativebroker";
	const LOGOUT_HINT = "logout_hint";
	const SID = "sid";
	const LOGIN_HINT = "login_hint";
	const DOMAIN_HINT = "domain_hint";
	const X_CLIENT_EXTRA_SKU = "x-client-xtra-sku";
	const BROKER_CLIENT_ID = "brk_client_id";
	const BROKER_REDIRECT_URI = "brk_redirect_uri";
	const INSTANCE_AWARE = "instance_aware";
	const EAR_JWK = "ear_jwk";
	const EAR_JWE_CRYPTO = "ear_jwe_crypto";
	const CLI_DATA = "clidata";
	var AADServerParamKeys = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		ACCESS_TOKEN,
		BROKER_CLIENT_ID,
		BROKER_REDIRECT_URI,
		CCS_HEADER,
		CLAIMS,
		CLIENT_ASSERTION,
		CLIENT_ASSERTION_TYPE,
		CLIENT_ID,
		CLIENT_INFO,
		CLIENT_REQUEST_ID,
		CLIENT_SECRET,
		CLI_DATA,
		CODE,
		CODE_CHALLENGE,
		CODE_CHALLENGE_METHOD,
		CODE_VERIFIER,
		DEVICE_CODE,
		DOMAIN_HINT,
		EAR_JWE_CRYPTO,
		EAR_JWK,
		ERROR,
		ERROR_DESCRIPTION,
		EXPIRES_IN,
		FOCI,
		GRANT_TYPE,
		ID_TOKEN,
		ID_TOKEN_HINT,
		INSTANCE_AWARE,
		LOGIN_HINT,
		LOGOUT_HINT,
		NATIVE_BROKER,
		NONCE,
		OBO_ASSERTION,
		ON_BEHALF_OF,
		POST_LOGOUT_URI,
		PROMPT,
		REDIRECT_URI,
		REFRESH_TOKEN,
		REFRESH_TOKEN_EXPIRES_IN,
		REQUESTED_TOKEN_USE,
		REQ_CNF,
		RESPONSE_MODE,
		RESPONSE_TYPE,
		RETURN_SPA_CODE,
		SCOPE,
		SESSION_STATE,
		SID,
		STATE,
		TOKEN_TYPE,
		X_APP_NAME,
		X_APP_VER,
		X_CLIENT_CPU,
		X_CLIENT_CURR_TELEM,
		X_CLIENT_EXTRA_SKU,
		X_CLIENT_LAST_TELEM,
		X_CLIENT_OS,
		X_CLIENT_SKU,
		X_CLIENT_VER,
		X_MS_LIB_CAPABILITY
	});
	const DEFAULT_CRYPTO_IMPLEMENTATION = {
		createNewGuid: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64Decode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64Encode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64UrlEncode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		encodeKid: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		async getPublicKeyThumbprint() {
			throw createClientAuthError(methodNotImplemented);
		},
		async removeTokenBindingKey() {
			throw createClientAuthError(methodNotImplemented);
		},
		async clearKeystore() {
			throw createClientAuthError(methodNotImplemented);
		},
		async signJwt() {
			throw createClientAuthError(methodNotImplemented);
		},
		async hashString() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	/**
	* Log message level.
	*/
	exports.LogLevel = void 0;
	(function(LogLevel) {
		LogLevel[LogLevel["Error"] = 0] = "Error";
		LogLevel[LogLevel["Warning"] = 1] = "Warning";
		LogLevel[LogLevel["Info"] = 2] = "Info";
		LogLevel[LogLevel["Verbose"] = 3] = "Verbose";
		LogLevel[LogLevel["Trace"] = 4] = "Trace";
	})(exports.LogLevel || (exports.LogLevel = {}));
	/**
	* Class which facilitates logging of messages to a specific place.
	*/
	var Logger = class Logger {
		constructor(loggerOptions, packageName, packageVersion) {
			this.level = exports.LogLevel.Info;
			const defaultLoggerCallback = () => {};
			const setLoggerOptions = loggerOptions || Logger.createDefaultLoggerOptions();
			this.localCallback = setLoggerOptions.loggerCallback || defaultLoggerCallback;
			this.piiLoggingEnabled = setLoggerOptions.piiLoggingEnabled || false;
			this.level = typeof setLoggerOptions.logLevel === "number" ? setLoggerOptions.logLevel : exports.LogLevel.Info;
			this.correlationId = setLoggerOptions.correlationId || Constants.EMPTY_STRING;
			this.packageName = packageName || Constants.EMPTY_STRING;
			this.packageVersion = packageVersion || Constants.EMPTY_STRING;
		}
		static createDefaultLoggerOptions() {
			return {
				loggerCallback: () => {},
				piiLoggingEnabled: false,
				logLevel: exports.LogLevel.Info
			};
		}
		/**
		* Create new Logger with existing configurations.
		*/
		clone(packageName, packageVersion, correlationId) {
			return new Logger({
				loggerCallback: this.localCallback,
				piiLoggingEnabled: this.piiLoggingEnabled,
				logLevel: this.level,
				correlationId: correlationId || this.correlationId
			}, packageName, packageVersion);
		}
		/**
		* Log message with required options.
		*/
		logMessage(logMessage, options) {
			if (options.logLevel > this.level || !this.piiLoggingEnabled && options.containsPii) return;
			const log = `${`[${(/* @__PURE__ */ new Date()).toUTCString()}] : [${options.correlationId || this.correlationId || ""}]`} : ${this.packageName}@${this.packageVersion} : ${exports.LogLevel[options.logLevel]} - ${logMessage}`;
			this.executeCallback(options.logLevel, log, options.containsPii || false);
		}
		/**
		* Execute callback with message.
		*/
		executeCallback(level, message, containsPii) {
			if (this.localCallback) this.localCallback(level, message, containsPii);
		}
		/**
		* Logs error messages.
		*/
		error(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Error,
				containsPii: false,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs error messages with PII.
		*/
		errorPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Error,
				containsPii: true,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs warning messages.
		*/
		warning(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Warning,
				containsPii: false,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs warning messages with PII.
		*/
		warningPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Warning,
				containsPii: true,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs info messages.
		*/
		info(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Info,
				containsPii: false,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs info messages with PII.
		*/
		infoPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Info,
				containsPii: true,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs verbose messages.
		*/
		verbose(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Verbose,
				containsPii: false,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs verbose messages with PII.
		*/
		verbosePii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Verbose,
				containsPii: true,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs trace messages.
		*/
		trace(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Trace,
				containsPii: false,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Logs trace messages with PII.
		*/
		tracePii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Trace,
				containsPii: true,
				correlationId: correlationId || Constants.EMPTY_STRING
			});
		}
		/**
		* Returns whether PII Logging is enabled or not.
		*/
		isPiiLoggingEnabled() {
			return this.piiLoggingEnabled || false;
		}
	};
	const name = "@azure/msal-common";
	const version = "15.17.0";
	/**
	* The ScopeSet class creates a set of scopes. Scopes are case-insensitive, unique values, so the Set object in JS makes
	* the most sense to implement for this class. All scopes are trimmed and converted to lower case strings in intersection and union functions
	* to ensure uniqueness of strings.
	*/
	var ScopeSet = class ScopeSet {
		constructor(inputScopes) {
			const scopeArr = inputScopes ? StringUtils.trimArrayEntries([...inputScopes]) : [];
			const filteredInput = scopeArr ? StringUtils.removeEmptyStringsFromArray(scopeArr) : [];
			if (!filteredInput || !filteredInput.length) throw createClientConfigurationError(emptyInputScopesError);
			this.scopes = /* @__PURE__ */ new Set();
			filteredInput.forEach((scope) => this.scopes.add(scope));
		}
		/**
		* Factory method to create ScopeSet from space-delimited string
		* @param inputScopeString
		* @param appClientId
		* @param scopesRequired
		*/
		static fromString(inputScopeString) {
			return new ScopeSet((inputScopeString || Constants.EMPTY_STRING).split(" "));
		}
		/**
		* Creates the set of scopes to search for in cache lookups
		* @param inputScopeString
		* @returns
		*/
		static createSearchScopes(inputScopeString) {
			const scopeSet = new ScopeSet(inputScopeString && inputScopeString.length > 0 ? inputScopeString : [...OIDC_DEFAULT_SCOPES]);
			if (!scopeSet.containsOnlyOIDCScopes()) scopeSet.removeOIDCScopes();
			else scopeSet.removeScope(Constants.OFFLINE_ACCESS_SCOPE);
			return scopeSet;
		}
		/**
		* Check if a given scope is present in this set of scopes.
		* @param scope
		*/
		containsScope(scope) {
			const lowerCaseScopesSet = new ScopeSet(this.printScopesLowerCase().split(" "));
			return scope ? lowerCaseScopesSet.scopes.has(scope.toLowerCase()) : false;
		}
		/**
		* Check if a set of scopes is present in this set of scopes.
		* @param scopeSet
		*/
		containsScopeSet(scopeSet) {
			if (!scopeSet || scopeSet.scopes.size <= 0) return false;
			return this.scopes.size >= scopeSet.scopes.size && scopeSet.asArray().every((scope) => this.containsScope(scope));
		}
		/**
		* Check if set of scopes contains only the defaults
		*/
		containsOnlyOIDCScopes() {
			let defaultScopeCount = 0;
			OIDC_SCOPES.forEach((defaultScope) => {
				if (this.containsScope(defaultScope)) defaultScopeCount += 1;
			});
			return this.scopes.size === defaultScopeCount;
		}
		/**
		* Appends single scope if passed
		* @param newScope
		*/
		appendScope(newScope) {
			if (newScope) this.scopes.add(newScope.trim());
		}
		/**
		* Appends multiple scopes if passed
		* @param newScopes
		*/
		appendScopes(newScopes) {
			try {
				newScopes.forEach((newScope) => this.appendScope(newScope));
			} catch (e) {
				throw createClientAuthError(cannotAppendScopeSet);
			}
		}
		/**
		* Removes element from set of scopes.
		* @param scope
		*/
		removeScope(scope) {
			if (!scope) throw createClientAuthError(cannotRemoveEmptyScope);
			this.scopes.delete(scope.trim());
		}
		/**
		* Removes default scopes from set of scopes
		* Primarily used to prevent cache misses if the default scopes are not returned from the server
		*/
		removeOIDCScopes() {
			OIDC_SCOPES.forEach((defaultScope) => {
				this.scopes.delete(defaultScope);
			});
		}
		/**
		* Combines an array of scopes with the current set of scopes.
		* @param otherScopes
		*/
		unionScopeSets(otherScopes) {
			if (!otherScopes) throw createClientAuthError(emptyInputScopeSet);
			const unionScopes = /* @__PURE__ */ new Set();
			otherScopes.scopes.forEach((scope) => unionScopes.add(scope.toLowerCase()));
			this.scopes.forEach((scope) => unionScopes.add(scope.toLowerCase()));
			return unionScopes;
		}
		/**
		* Check if scopes intersect between this set and another.
		* @param otherScopes
		*/
		intersectingScopeSets(otherScopes) {
			if (!otherScopes) throw createClientAuthError(emptyInputScopeSet);
			if (!otherScopes.containsOnlyOIDCScopes()) otherScopes.removeOIDCScopes();
			const unionScopes = this.unionScopeSets(otherScopes);
			const sizeOtherScopes = otherScopes.getScopeCount();
			const sizeThisScopes = this.getScopeCount();
			return unionScopes.size < sizeThisScopes + sizeOtherScopes;
		}
		/**
		* Returns size of set of scopes.
		*/
		getScopeCount() {
			return this.scopes.size;
		}
		/**
		* Returns the scopes as an array of string values
		*/
		asArray() {
			const array = [];
			this.scopes.forEach((val) => array.push(val));
			return array;
		}
		/**
		* Prints scopes into a space-delimited string
		*/
		printScopes() {
			if (this.scopes) return this.asArray().join(" ");
			return Constants.EMPTY_STRING;
		}
		/**
		* Prints scopes into a space-delimited lower-case string (used for caching)
		*/
		printScopesLowerCase() {
			return this.printScopes().toLowerCase();
		}
	};
	/**
	* Function to build a client info object from server clientInfo string
	* @param rawClientInfo
	* @param crypto
	*/
	function buildClientInfo(rawClientInfo, base64Decode) {
		if (!rawClientInfo) throw createClientAuthError(clientInfoEmptyError);
		try {
			const decodedClientInfo = base64Decode(rawClientInfo);
			return JSON.parse(decodedClientInfo);
		} catch (e) {
			throw createClientAuthError(clientInfoDecodingError);
		}
	}
	/**
	* Function to build a client info object from cached homeAccountId string
	* @param homeAccountId
	*/
	function buildClientInfoFromHomeAccountId(homeAccountId) {
		if (!homeAccountId) throw createClientAuthError(clientInfoDecodingError);
		const clientInfoParts = homeAccountId.split(Separators.CLIENT_INFO_SEPARATOR, 2);
		return {
			uid: clientInfoParts[0],
			utid: clientInfoParts.length < 2 ? Constants.EMPTY_STRING : clientInfoParts[1]
		};
	}
	/**
	* Returns true if tenantId matches the utid portion of homeAccountId
	* @param tenantId
	* @param homeAccountId
	* @returns
	*/
	function tenantIdMatchesHomeTenant(tenantId, homeAccountId) {
		return !!tenantId && !!homeAccountId && tenantId === homeAccountId.split(".")[1];
	}
	/**
	* Build tenant profile
	* @param homeAccountId - Home account identifier for this account object
	* @param localAccountId - Local account identifer for this account object
	* @param tenantId - Full tenant or organizational id that this account belongs to
	* @param idTokenClaims - Claims from the ID token
	* @returns
	*/
	function buildTenantProfile(homeAccountId, localAccountId, tenantId, idTokenClaims) {
		if (idTokenClaims) {
			const { oid, sub, tid, name, tfp, acr, preferred_username, upn, login_hint } = idTokenClaims;
			/**
			* Since there is no way to determine if the authority is AAD or B2C, we exhaust all the possible claims that can serve as tenant ID with the following precedence:
			* tid - TenantID claim that identifies the tenant that issued the token in AAD. Expected in all AAD ID tokens, not present in B2C ID Tokens.
			* tfp - Trust Framework Policy claim that identifies the policy that was used to authenticate the user. Functions as tenant for B2C scenarios.
			* acr - Authentication Context Class Reference claim used only with older B2C policies. Fallback in case tfp is not present, but likely won't be present anyway.
			*/
			const tenantId = tid || tfp || acr || "";
			return {
				tenantId,
				localAccountId: oid || sub || "",
				name,
				username: preferred_username || upn || "",
				loginHint: login_hint,
				isHomeTenant: tenantIdMatchesHomeTenant(tenantId, homeAccountId)
			};
		} else return {
			tenantId,
			localAccountId,
			username: "",
			isHomeTenant: tenantIdMatchesHomeTenant(tenantId, homeAccountId)
		};
	}
	/**
	* Replaces account info that varies by tenant profile sourced from the ID token claims passed in with the tenant-specific account info
	* @param baseAccountInfo
	* @param idTokenClaims
	* @returns
	*/
	function updateAccountTenantProfileData(baseAccountInfo, tenantProfile, idTokenClaims, idTokenSecret) {
		let updatedAccountInfo = baseAccountInfo;
		if (tenantProfile) {
			const { isHomeTenant, ...tenantProfileOverride } = tenantProfile;
			updatedAccountInfo = {
				...baseAccountInfo,
				...tenantProfileOverride
			};
		}
		if (idTokenClaims) {
			const { isHomeTenant, ...claimsSourcedTenantProfile } = buildTenantProfile(baseAccountInfo.homeAccountId, baseAccountInfo.localAccountId, baseAccountInfo.tenantId, idTokenClaims);
			updatedAccountInfo = {
				...updatedAccountInfo,
				...claimsSourcedTenantProfile,
				idTokenClaims,
				idToken: idTokenSecret
			};
			return updatedAccountInfo;
		}
		return updatedAccountInfo;
	}
	/**
	* Gets tenantId from available ID token claims to set as credential realm with the following precedence:
	* 1. tid - if the token is acquired from an Azure AD tenant tid will be present
	* 2. tfp - if the token is acquired from a modern B2C tenant tfp should be present
	* 3. acr - if the token is acquired from a legacy B2C tenant acr should be present
	* Downcased to match the realm case-insensitive comparison requirements
	* @param idTokenClaims
	* @returns
	*/
	function getTenantIdFromIdTokenClaims(idTokenClaims) {
		if (idTokenClaims) return idTokenClaims.tid || idTokenClaims.tfp || idTokenClaims.acr || null;
		return null;
	}
	/**
	* Type that defines required and optional parameters for an Account field (based on universal cache schema implemented by all MSALs).
	*
	* Key : Value Schema
	*
	* Key: <home_account_id>-<environment>-<realm*>
	*
	* Value Schema:
	* {
	*      homeAccountId: home account identifier for the auth scheme,
	*      environment: entity that issued the token, represented as a full host
	*      realm: Full tenant or organizational identifier that the account belongs to
	*      localAccountId: Original tenant-specific accountID, usually used for legacy cases
	*      username: primary username that represents the user, usually corresponds to preferred_username in the v2 endpt
	*      authorityType: Accounts authority type as a string
	*      name: Full name for the account, including given name and family name,
	*      lastModificationTime: last time this entity was modified in the cache
	*      lastModificationApp:
	*      nativeAccountId: Account identifier on the native device
	*      tenantProfiles: Array of tenant profile objects for each tenant that the account has authenticated with in the browser
	* }
	* @internal
	*/
	var AccountEntity = class AccountEntity {
		/**
		* Returns the AccountInfo interface for this account.
		*/
		static getAccountInfo(accountEntity) {
			const tenantProfiles = accountEntity.tenantProfiles || [];
			if (tenantProfiles.length === 0 && accountEntity.realm && accountEntity.localAccountId) tenantProfiles.push(buildTenantProfile(accountEntity.homeAccountId, accountEntity.localAccountId, accountEntity.realm));
			return {
				homeAccountId: accountEntity.homeAccountId,
				environment: accountEntity.environment,
				tenantId: accountEntity.realm,
				username: accountEntity.username,
				localAccountId: accountEntity.localAccountId,
				loginHint: accountEntity.loginHint,
				name: accountEntity.name,
				nativeAccountId: accountEntity.nativeAccountId,
				authorityType: accountEntity.authorityType,
				tenantProfiles: new Map(tenantProfiles.map((tenantProfile) => {
					return [tenantProfile.tenantId, tenantProfile];
				})),
				dataBoundary: accountEntity.dataBoundary
			};
		}
		/**
		* Returns true if the account entity is in single tenant format (outdated), false otherwise
		*/
		isSingleTenant() {
			return !this.tenantProfiles;
		}
		/**
		* Build Account cache from IdToken, clientInfo and authority/policy. Associated with AAD.
		* @param accountDetails
		*/
		static createAccount(accountDetails, authority, base64Decode) {
			const account = new AccountEntity();
			if (authority.authorityType === AuthorityType.Adfs) account.authorityType = CacheAccountType.ADFS_ACCOUNT_TYPE;
			else if (authority.protocolMode === ProtocolMode.OIDC) account.authorityType = CacheAccountType.GENERIC_ACCOUNT_TYPE;
			else account.authorityType = CacheAccountType.MSSTS_ACCOUNT_TYPE;
			let clientInfo;
			if (accountDetails.clientInfo && base64Decode) {
				clientInfo = buildClientInfo(accountDetails.clientInfo, base64Decode);
				if (clientInfo.xms_tdbr) account.dataBoundary = clientInfo.xms_tdbr === "EU" ? "EU" : "None";
			}
			account.clientInfo = accountDetails.clientInfo;
			account.homeAccountId = accountDetails.homeAccountId;
			account.nativeAccountId = accountDetails.nativeAccountId;
			const env = accountDetails.environment || authority && authority.getPreferredCache();
			if (!env) throw createClientAuthError(invalidCacheEnvironment);
			account.environment = env;
			account.realm = clientInfo?.utid || getTenantIdFromIdTokenClaims(accountDetails.idTokenClaims) || "";
			account.localAccountId = clientInfo?.uid || accountDetails.idTokenClaims?.oid || accountDetails.idTokenClaims?.sub || "";
			const preferredUsername = accountDetails.idTokenClaims?.preferred_username || accountDetails.idTokenClaims?.upn;
			const email = accountDetails.idTokenClaims?.emails ? accountDetails.idTokenClaims.emails[0] : null;
			account.username = preferredUsername || email || "";
			account.loginHint = accountDetails.idTokenClaims?.login_hint;
			account.name = accountDetails.idTokenClaims?.name || "";
			account.cloudGraphHostName = accountDetails.cloudGraphHostName;
			account.msGraphHost = accountDetails.msGraphHost;
			if (accountDetails.tenantProfiles) account.tenantProfiles = accountDetails.tenantProfiles;
			else account.tenantProfiles = [buildTenantProfile(accountDetails.homeAccountId, account.localAccountId, account.realm, accountDetails.idTokenClaims)];
			return account;
		}
		/**
		* Creates an AccountEntity object from AccountInfo
		* @param accountInfo
		* @param cloudGraphHostName
		* @param msGraphHost
		* @returns
		*/
		static createFromAccountInfo(accountInfo, cloudGraphHostName, msGraphHost) {
			const account = new AccountEntity();
			account.authorityType = accountInfo.authorityType || CacheAccountType.GENERIC_ACCOUNT_TYPE;
			account.homeAccountId = accountInfo.homeAccountId;
			account.localAccountId = accountInfo.localAccountId;
			account.nativeAccountId = accountInfo.nativeAccountId;
			account.realm = accountInfo.tenantId;
			account.environment = accountInfo.environment;
			account.username = accountInfo.username;
			account.name = accountInfo.name;
			account.loginHint = accountInfo.loginHint;
			account.cloudGraphHostName = cloudGraphHostName;
			account.msGraphHost = msGraphHost;
			const tenantProfiles = Array.from(accountInfo.tenantProfiles?.values() || []);
			if (tenantProfiles.length === 0 && accountInfo.tenantId && accountInfo.localAccountId) tenantProfiles.push(buildTenantProfile(accountInfo.homeAccountId, accountInfo.localAccountId, accountInfo.tenantId, accountInfo.idTokenClaims));
			account.tenantProfiles = tenantProfiles;
			account.dataBoundary = accountInfo.dataBoundary;
			return account;
		}
		/**
		* Generate HomeAccountId from server response
		* @param serverClientInfo
		* @param authType
		*/
		static generateHomeAccountId(serverClientInfo, authType, logger, cryptoObj, idTokenClaims) {
			if (!(authType === AuthorityType.Adfs || authType === AuthorityType.Dsts)) {
				if (serverClientInfo) try {
					const clientInfo = buildClientInfo(serverClientInfo, cryptoObj.base64Decode);
					if (clientInfo.uid && clientInfo.utid) return `${clientInfo.uid}.${clientInfo.utid}`;
				} catch (e) {}
				logger.warning("No client info in response");
			}
			return idTokenClaims?.sub || "";
		}
		/**
		* Validates an entity: checks for all expected params
		* @param entity
		*/
		static isAccountEntity(entity) {
			if (!entity) return false;
			return entity.hasOwnProperty("homeAccountId") && entity.hasOwnProperty("environment") && entity.hasOwnProperty("realm") && entity.hasOwnProperty("localAccountId") && entity.hasOwnProperty("username") && entity.hasOwnProperty("authorityType");
		}
		/**
		* Helper function to determine whether 2 accountInfo objects represent the same account
		* @param accountA
		* @param accountB
		* @param compareClaims - If set to true idTokenClaims will also be compared to determine account equality
		*/
		static accountInfoIsEqual(accountA, accountB, compareClaims) {
			if (!accountA || !accountB) return false;
			let claimsMatch = true;
			if (compareClaims) {
				const accountAClaims = accountA.idTokenClaims || {};
				const accountBClaims = accountB.idTokenClaims || {};
				claimsMatch = accountAClaims.iat === accountBClaims.iat && accountAClaims.nonce === accountBClaims.nonce;
			}
			return accountA.homeAccountId === accountB.homeAccountId && accountA.localAccountId === accountB.localAccountId && accountA.username === accountB.username && accountA.tenantId === accountB.tenantId && accountA.loginHint === accountB.loginHint && accountA.environment === accountB.environment && accountA.nativeAccountId === accountB.nativeAccountId && claimsMatch;
		}
	};
	const cacheQuotaExceeded = "cache_quota_exceeded";
	const cacheErrorUnknown = "cache_error_unknown";
	var CacheErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		cacheErrorUnknown,
		cacheQuotaExceeded
	});
	const CacheErrorMessages = {
		[cacheQuotaExceeded]: "Exceeded cache storage capacity.",
		[cacheErrorUnknown]: "Unexpected error occurred when using cache storage."
	};
	/**
	* Error thrown when there is an error with the cache
	*/
	var CacheError = class CacheError extends AuthError {
		constructor(errorCode, errorMessage) {
			const message = errorMessage || (CacheErrorMessages[errorCode] ? CacheErrorMessages[errorCode] : CacheErrorMessages[cacheErrorUnknown]);
			super(`${errorCode}: ${message}`);
			Object.setPrototypeOf(this, CacheError.prototype);
			this.name = "CacheError";
			this.errorCode = errorCode;
			this.errorMessage = message;
		}
	};
	/**
	* Helper function to wrap browser errors in a CacheError object
	* @param e
	* @returns
	*/
	function createCacheError(e) {
		if (!(e instanceof Error)) return new CacheError(cacheErrorUnknown);
		if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.message.includes("exceeded the quota")) return new CacheError(cacheQuotaExceeded);
		else return new CacheError(e.name, e.message);
	}
	/**
	* Interface class which implement cache storage functions used by MSAL to perform validity checks, and store tokens.
	* @internal
	*/
	var CacheManager = class {
		constructor(clientId, cryptoImpl, logger, performanceClient, staticAuthorityOptions) {
			this.clientId = clientId;
			this.cryptoImpl = cryptoImpl;
			this.commonLogger = logger.clone(name, version);
			this.staticAuthorityOptions = staticAuthorityOptions;
			this.performanceClient = performanceClient;
		}
		/**
		* Returns all the accounts in the cache that match the optional filter. If no filter is provided, all accounts are returned.
		* @param accountFilter - (Optional) filter to narrow down the accounts returned
		* @returns Array of AccountInfo objects in cache
		*/
		getAllAccounts(accountFilter, correlationId) {
			return this.buildTenantProfiles(this.getAccountsFilteredBy(accountFilter, correlationId), correlationId, accountFilter);
		}
		/**
		* Gets first tenanted AccountInfo object found based on provided filters
		*/
		getAccountInfoFilteredBy(accountFilter, correlationId) {
			if (Object.keys(accountFilter).length === 0 || Object.values(accountFilter).every((value) => !value)) {
				this.commonLogger.warning("getAccountInfoFilteredBy: Account filter is empty or invalid, returning null");
				return null;
			}
			const allAccounts = this.getAllAccounts(accountFilter, correlationId);
			if (allAccounts.length > 1) return allAccounts.sort((account) => {
				return account.idTokenClaims ? -1 : 1;
			})[0];
			else if (allAccounts.length === 1) return allAccounts[0];
			else return null;
		}
		/**
		* Returns a single matching
		* @param accountFilter
		* @returns
		*/
		getBaseAccountInfo(accountFilter, correlationId) {
			const accountEntities = this.getAccountsFilteredBy(accountFilter, correlationId);
			if (accountEntities.length > 0) return AccountEntity.getAccountInfo(accountEntities[0]);
			else return null;
		}
		/**
		* Matches filtered account entities with cached ID tokens that match the tenant profile-specific account filters
		* and builds the account info objects from the matching ID token's claims
		* @param cachedAccounts
		* @param accountFilter
		* @returns Array of AccountInfo objects that match account and tenant profile filters
		*/
		buildTenantProfiles(cachedAccounts, correlationId, accountFilter) {
			return cachedAccounts.flatMap((accountEntity) => {
				return this.getTenantProfilesFromAccountEntity(accountEntity, correlationId, accountFilter?.tenantId, accountFilter);
			});
		}
		getTenantedAccountInfoByFilter(accountInfo, tokenKeys, tenantProfile, correlationId, tenantProfileFilter) {
			let tenantedAccountInfo = null;
			let idTokenClaims;
			if (tenantProfileFilter) {
				if (!this.tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter)) return null;
			}
			const idToken = this.getIdToken(accountInfo, correlationId, tokenKeys, tenantProfile.tenantId);
			if (idToken) {
				idTokenClaims = extractTokenClaims(idToken.secret, this.cryptoImpl.base64Decode);
				if (!this.idTokenClaimsMatchTenantProfileFilter(idTokenClaims, tenantProfileFilter)) return null;
			}
			tenantedAccountInfo = updateAccountTenantProfileData(accountInfo, tenantProfile, idTokenClaims, idToken?.secret);
			return tenantedAccountInfo;
		}
		getTenantProfilesFromAccountEntity(accountEntity, correlationId, targetTenantId, tenantProfileFilter) {
			const accountInfo = AccountEntity.getAccountInfo(accountEntity);
			let searchTenantProfiles = accountInfo.tenantProfiles || /* @__PURE__ */ new Map();
			const tokenKeys = this.getTokenKeys();
			if (targetTenantId) {
				const tenantProfile = searchTenantProfiles.get(targetTenantId);
				if (tenantProfile) searchTenantProfiles = new Map([[targetTenantId, tenantProfile]]);
				else return [];
			}
			const matchingTenantProfiles = [];
			searchTenantProfiles.forEach((tenantProfile) => {
				const tenantedAccountInfo = this.getTenantedAccountInfoByFilter(accountInfo, tokenKeys, tenantProfile, correlationId, tenantProfileFilter);
				if (tenantedAccountInfo) matchingTenantProfiles.push(tenantedAccountInfo);
			});
			return matchingTenantProfiles;
		}
		tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter) {
			if (!!tenantProfileFilter.localAccountId && !this.matchLocalAccountIdFromTenantProfile(tenantProfile, tenantProfileFilter.localAccountId)) return false;
			if (!!tenantProfileFilter.name && !(tenantProfile.name === tenantProfileFilter.name)) return false;
			if (tenantProfileFilter.isHomeTenant !== void 0 && !(tenantProfile.isHomeTenant === tenantProfileFilter.isHomeTenant)) return false;
			return true;
		}
		idTokenClaimsMatchTenantProfileFilter(idTokenClaims, tenantProfileFilter) {
			if (tenantProfileFilter) {
				if (!!tenantProfileFilter.localAccountId && !this.matchLocalAccountIdFromTokenClaims(idTokenClaims, tenantProfileFilter.localAccountId)) return false;
				if (!!tenantProfileFilter.loginHint && !this.matchLoginHintFromTokenClaims(idTokenClaims, tenantProfileFilter.loginHint)) return false;
				if (!!tenantProfileFilter.username && !this.matchUsername(idTokenClaims.preferred_username, tenantProfileFilter.username)) return false;
				if (!!tenantProfileFilter.name && !this.matchName(idTokenClaims, tenantProfileFilter.name)) return false;
				if (!!tenantProfileFilter.sid && !this.matchSid(idTokenClaims, tenantProfileFilter.sid)) return false;
			}
			return true;
		}
		/**
		* saves a cache record
		* @param cacheRecord {CacheRecord}
		* @param correlationId {?string} correlation id
		* @param kmsi - Keep Me Signed In
		* @param apiId - API identifier for telemetry tracking
		* @param storeInCache {?StoreInCache}
		*/
		async saveCacheRecord(cacheRecord, correlationId, kmsi, apiId, storeInCache) {
			if (!cacheRecord) throw createClientAuthError(invalidCacheRecord);
			try {
				if (!!cacheRecord.account) await this.setAccount(cacheRecord.account, correlationId, kmsi, apiId);
				if (!!cacheRecord.idToken && storeInCache?.idToken !== false) await this.setIdTokenCredential(cacheRecord.idToken, correlationId, kmsi);
				if (!!cacheRecord.accessToken && storeInCache?.accessToken !== false) await this.saveAccessToken(cacheRecord.accessToken, correlationId, kmsi);
				if (!!cacheRecord.refreshToken && storeInCache?.refreshToken !== false) await this.setRefreshTokenCredential(cacheRecord.refreshToken, correlationId, kmsi);
				if (!!cacheRecord.appMetadata) this.setAppMetadata(cacheRecord.appMetadata, correlationId);
			} catch (e) {
				this.commonLogger?.error(`CacheManager.saveCacheRecord: failed`);
				if (e instanceof AuthError) throw e;
				else throw createCacheError(e);
			}
		}
		/**
		* saves access token credential
		* @param credential
		*/
		async saveAccessToken(credential, correlationId, kmsi) {
			const accessTokenFilter = {
				clientId: credential.clientId,
				credentialType: credential.credentialType,
				environment: credential.environment,
				homeAccountId: credential.homeAccountId,
				realm: credential.realm,
				tokenType: credential.tokenType,
				requestedClaimsHash: credential.requestedClaimsHash
			};
			const tokenKeys = this.getTokenKeys();
			const currentScopes = ScopeSet.fromString(credential.target);
			tokenKeys.accessToken.forEach((key) => {
				if (!this.accessTokenKeyMatchesFilter(key, accessTokenFilter, false)) return;
				const tokenEntity = this.getAccessTokenCredential(key, correlationId);
				if (tokenEntity && this.credentialMatchesFilter(tokenEntity, accessTokenFilter)) {
					if (ScopeSet.fromString(tokenEntity.target).intersectingScopeSets(currentScopes)) this.removeAccessToken(key, correlationId);
				}
			});
			await this.setAccessTokenCredential(credential, correlationId, kmsi);
		}
		/**
		* Retrieve account entities matching all provided tenant-agnostic filters; if no filter is set, get all account entities in the cache
		* Not checking for casing as keys are all generated in lower case, remember to convert to lower case if object properties are compared
		* @param accountFilter - An object containing Account properties to filter by
		*/
		getAccountsFilteredBy(accountFilter, correlationId) {
			const allAccountKeys = this.getAccountKeys();
			const matchingAccounts = [];
			allAccountKeys.forEach((cacheKey) => {
				const entity = this.getAccount(cacheKey, correlationId);
				if (!entity) return;
				if (!!accountFilter.homeAccountId && !this.matchHomeAccountId(entity, accountFilter.homeAccountId)) return;
				if (!!accountFilter.username && !this.matchUsername(entity.username, accountFilter.username)) return;
				if (!!accountFilter.environment && !this.matchEnvironment(entity, accountFilter.environment)) return;
				if (!!accountFilter.realm && !this.matchRealm(entity, accountFilter.realm)) return;
				if (!!accountFilter.nativeAccountId && !this.matchNativeAccountId(entity, accountFilter.nativeAccountId)) return;
				if (!!accountFilter.authorityType && !this.matchAuthorityType(entity, accountFilter.authorityType)) return;
				const tenantProfileFilter = {
					localAccountId: accountFilter?.localAccountId,
					name: accountFilter?.name
				};
				const matchingTenantProfiles = entity.tenantProfiles?.filter((tenantProfile) => {
					return this.tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter);
				});
				if (matchingTenantProfiles && matchingTenantProfiles.length === 0) return;
				matchingAccounts.push(entity);
			});
			return matchingAccounts;
		}
		/**
		* Returns whether or not the given credential entity matches the filter
		* @param entity
		* @param filter
		* @returns
		*/
		credentialMatchesFilter(entity, filter) {
			if (!!filter.clientId && !this.matchClientId(entity, filter.clientId)) return false;
			if (!!filter.userAssertionHash && !this.matchUserAssertionHash(entity, filter.userAssertionHash)) return false;
			if (typeof filter.homeAccountId === "string" && !this.matchHomeAccountId(entity, filter.homeAccountId)) return false;
			if (!!filter.environment && !this.matchEnvironment(entity, filter.environment)) return false;
			if (!!filter.realm && !this.matchRealm(entity, filter.realm)) return false;
			if (!!filter.credentialType && !this.matchCredentialType(entity, filter.credentialType)) return false;
			if (!!filter.familyId && !this.matchFamilyId(entity, filter.familyId)) return false;
			if (!!filter.target && !this.matchTarget(entity, filter.target)) return false;
			if (filter.requestedClaimsHash || entity.requestedClaimsHash) {
				if (entity.requestedClaimsHash !== filter.requestedClaimsHash) return false;
			}
			if (entity.credentialType === CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME) {
				if (!!filter.tokenType && !this.matchTokenType(entity, filter.tokenType)) return false;
				if (filter.tokenType === AuthenticationScheme.SSH) {
					if (filter.keyId && !this.matchKeyId(entity, filter.keyId)) return false;
				}
			}
			return true;
		}
		/**
		* retrieve appMetadata matching all provided filters; if no filter is set, get all appMetadata
		* @param filter
		*/
		getAppMetadataFilteredBy(filter) {
			const allCacheKeys = this.getKeys();
			const matchingAppMetadata = {};
			allCacheKeys.forEach((cacheKey) => {
				if (!this.isAppMetadata(cacheKey)) return;
				const entity = this.getAppMetadata(cacheKey);
				if (!entity) return;
				if (!!filter.environment && !this.matchEnvironment(entity, filter.environment)) return;
				if (!!filter.clientId && !this.matchClientId(entity, filter.clientId)) return;
				matchingAppMetadata[cacheKey] = entity;
			});
			return matchingAppMetadata;
		}
		/**
		* retrieve authorityMetadata that contains a matching alias
		* @param filter
		*/
		getAuthorityMetadataByAlias(host) {
			const allCacheKeys = this.getAuthorityMetadataKeys();
			let matchedEntity = null;
			allCacheKeys.forEach((cacheKey) => {
				if (!this.isAuthorityMetadata(cacheKey) || cacheKey.indexOf(this.clientId) === -1) return;
				const entity = this.getAuthorityMetadata(cacheKey);
				if (!entity) return;
				if (entity.aliases.indexOf(host) === -1) return;
				matchedEntity = entity;
			});
			return matchedEntity;
		}
		/**
		* Removes all accounts and related tokens from cache.
		*/
		removeAllAccounts(correlationId) {
			this.getAllAccounts({}, correlationId).forEach((account) => {
				this.removeAccount(account, correlationId);
			});
		}
		/**
		* Removes the account and related tokens for a given account key
		* @param account
		*/
		removeAccount(account, correlationId) {
			this.removeAccountContext(account, correlationId);
			const accountKeys = this.getAccountKeys();
			const keyFilter = (key) => {
				return key.includes(account.homeAccountId) && key.includes(account.environment);
			};
			accountKeys.filter(keyFilter).forEach((key) => {
				this.removeItem(key, correlationId);
				this.performanceClient.incrementFields({ accountsRemoved: 1 }, correlationId);
			});
		}
		/**
		* Removes credentials associated with the provided account
		* @param account
		*/
		removeAccountContext(account, correlationId) {
			const allTokenKeys = this.getTokenKeys();
			const keyFilter = (key) => {
				return key.includes(account.homeAccountId) && key.includes(account.environment);
			};
			allTokenKeys.idToken.filter(keyFilter).forEach((key) => {
				this.removeIdToken(key, correlationId);
			});
			allTokenKeys.accessToken.filter(keyFilter).forEach((key) => {
				this.removeAccessToken(key, correlationId);
			});
			allTokenKeys.refreshToken.filter(keyFilter).forEach((key) => {
				this.removeRefreshToken(key, correlationId);
			});
		}
		/**
		* Removes accessToken from the cache
		* @param key
		* @param correlationId
		*/
		removeAccessToken(key, correlationId) {
			const credential = this.getAccessTokenCredential(key, correlationId);
			this.removeItem(key, correlationId);
			this.performanceClient.incrementFields({ accessTokensRemoved: 1 }, correlationId);
			if (!credential || credential.credentialType.toLowerCase() !== CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME.toLowerCase() || credential.tokenType !== AuthenticationScheme.POP) return;
			const kid = credential.keyId;
			if (kid) this.cryptoImpl.removeTokenBindingKey(kid).catch(() => {
				this.commonLogger.error(`Failed to remove token binding key ${kid}`, correlationId);
				this.performanceClient?.incrementFields({ removeTokenBindingKeyFailure: 1 }, correlationId);
			});
		}
		/**
		* Removes all app metadata objects from cache.
		*/
		removeAppMetadata(correlationId) {
			this.getKeys().forEach((cacheKey) => {
				if (this.isAppMetadata(cacheKey)) this.removeItem(cacheKey, correlationId);
			});
			return true;
		}
		/**
		* Retrieve IdTokenEntity from cache
		* @param account {AccountInfo}
		* @param tokenKeys {?TokenKeys}
		* @param targetRealm {?string}
		* @param performanceClient {?IPerformanceClient}
		* @param correlationId {?string}
		*/
		getIdToken(account, correlationId, tokenKeys, targetRealm, performanceClient) {
			this.commonLogger.trace("CacheManager - getIdToken called");
			const idTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType: CredentialType.ID_TOKEN,
				clientId: this.clientId,
				realm: targetRealm
			};
			const idTokenMap = this.getIdTokensByFilter(idTokenFilter, correlationId, tokenKeys);
			const numIdTokens = idTokenMap.size;
			if (numIdTokens < 1) {
				this.commonLogger.info("CacheManager:getIdToken - No token found");
				return null;
			} else if (numIdTokens > 1) {
				let tokensToBeRemoved = idTokenMap;
				if (!targetRealm) {
					const homeIdTokenMap = /* @__PURE__ */ new Map();
					idTokenMap.forEach((idToken, key) => {
						if (idToken.realm === account.tenantId) homeIdTokenMap.set(key, idToken);
					});
					const numHomeIdTokens = homeIdTokenMap.size;
					if (numHomeIdTokens < 1) {
						this.commonLogger.info("CacheManager:getIdToken - Multiple ID tokens found for account but none match account entity tenant id, returning first result");
						return idTokenMap.values().next().value;
					} else if (numHomeIdTokens === 1) {
						this.commonLogger.info("CacheManager:getIdToken - Multiple ID tokens found for account, defaulting to home tenant profile");
						return homeIdTokenMap.values().next().value;
					} else tokensToBeRemoved = homeIdTokenMap;
				}
				this.commonLogger.info("CacheManager:getIdToken - Multiple matching ID tokens found, clearing them");
				tokensToBeRemoved.forEach((idToken, key) => {
					this.removeIdToken(key, correlationId);
				});
				if (performanceClient && correlationId) performanceClient.addFields({ multiMatchedID: idTokenMap.size }, correlationId);
				return null;
			}
			this.commonLogger.info("CacheManager:getIdToken - Returning ID token");
			return idTokenMap.values().next().value;
		}
		/**
		* Gets all idTokens matching the given filter
		* @param filter
		* @returns
		*/
		getIdTokensByFilter(filter, correlationId, tokenKeys) {
			const idTokenKeys = tokenKeys && tokenKeys.idToken || this.getTokenKeys().idToken;
			const idTokens = /* @__PURE__ */ new Map();
			idTokenKeys.forEach((key) => {
				if (!this.idTokenKeyMatchesFilter(key, {
					clientId: this.clientId,
					...filter
				})) return;
				const idToken = this.getIdTokenCredential(key, correlationId);
				if (idToken && this.credentialMatchesFilter(idToken, filter)) idTokens.set(key, idToken);
			});
			return idTokens;
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		* @returns
		*/
		idTokenKeyMatchesFilter(inputKey, filter) {
			const key = inputKey.toLowerCase();
			if (filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			return true;
		}
		/**
		* Removes idToken from the cache
		* @param key
		*/
		removeIdToken(key, correlationId) {
			this.removeItem(key, correlationId);
		}
		/**
		* Removes refresh token from the cache
		* @param key
		*/
		removeRefreshToken(key, correlationId) {
			this.removeItem(key, correlationId);
		}
		/**
		* Retrieve AccessTokenEntity from cache
		* @param account {AccountInfo}
		* @param request {BaseAuthRequest}
		* @param correlationId {?string}
		* @param tokenKeys {?TokenKeys}
		* @param performanceClient {?IPerformanceClient}
		*/
		getAccessToken(account, request, tokenKeys, targetRealm) {
			const correlationId = request.correlationId;
			this.commonLogger.trace("CacheManager - getAccessToken called", correlationId);
			const scopes = ScopeSet.createSearchScopes(request.scopes);
			const authScheme = request.authenticationScheme || AuthenticationScheme.BEARER;
			const credentialType = authScheme && authScheme.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase() ? CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME : CredentialType.ACCESS_TOKEN;
			const accessTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType,
				clientId: this.clientId,
				realm: targetRealm || account.tenantId,
				target: scopes,
				tokenType: authScheme,
				keyId: request.sshKid,
				requestedClaimsHash: request.requestedClaimsHash
			};
			const accessTokenKeys = tokenKeys && tokenKeys.accessToken || this.getTokenKeys().accessToken;
			const accessTokens = [];
			accessTokenKeys.forEach((key) => {
				if (this.accessTokenKeyMatchesFilter(key, accessTokenFilter, true)) {
					const accessToken = this.getAccessTokenCredential(key, correlationId);
					if (accessToken && this.credentialMatchesFilter(accessToken, accessTokenFilter)) accessTokens.push(accessToken);
				}
			});
			const numAccessTokens = accessTokens.length;
			if (numAccessTokens < 1) {
				this.commonLogger.info("CacheManager:getAccessToken - No token found", correlationId);
				return null;
			} else if (numAccessTokens > 1) {
				this.commonLogger.info("CacheManager:getAccessToken - Multiple access tokens found, clearing them", correlationId);
				accessTokens.forEach((accessToken) => {
					this.removeAccessToken(this.generateCredentialKey(accessToken), correlationId);
				});
				this.performanceClient.addFields({ multiMatchedAT: accessTokens.length }, correlationId);
				return null;
			}
			this.commonLogger.info("CacheManager:getAccessToken - Returning access token", correlationId);
			return accessTokens[0];
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		* @param keyMustContainAllScopes
		* @returns
		*/
		accessTokenKeyMatchesFilter(inputKey, filter, keyMustContainAllScopes) {
			const key = inputKey.toLowerCase();
			if (filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			if (filter.realm && key.indexOf(filter.realm.toLowerCase()) === -1) return false;
			if (filter.requestedClaimsHash && key.indexOf(filter.requestedClaimsHash.toLowerCase()) === -1) return false;
			if (filter.target) {
				const scopes = filter.target.asArray();
				for (let i = 0; i < scopes.length; i++) if (keyMustContainAllScopes && !key.includes(scopes[i].toLowerCase())) return false;
				else if (!keyMustContainAllScopes && key.includes(scopes[i].toLowerCase())) return true;
			}
			return true;
		}
		/**
		* Gets all access tokens matching the filter
		* @param filter
		* @returns
		*/
		getAccessTokensByFilter(filter, correlationId) {
			const tokenKeys = this.getTokenKeys();
			const accessTokens = [];
			tokenKeys.accessToken.forEach((key) => {
				if (!this.accessTokenKeyMatchesFilter(key, filter, true)) return;
				const accessToken = this.getAccessTokenCredential(key, correlationId);
				if (accessToken && this.credentialMatchesFilter(accessToken, filter)) accessTokens.push(accessToken);
			});
			return accessTokens;
		}
		/**
		* Helper to retrieve the appropriate refresh token from cache
		* @param account {AccountInfo}
		* @param familyRT {boolean}
		* @param correlationId {?string}
		* @param tokenKeys {?TokenKeys}
		* @param performanceClient {?IPerformanceClient}
		*/
		getRefreshToken(account, familyRT, correlationId, tokenKeys, performanceClient) {
			this.commonLogger.trace("CacheManager - getRefreshToken called");
			const id = familyRT ? THE_FAMILY_ID : void 0;
			const refreshTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType: CredentialType.REFRESH_TOKEN,
				clientId: this.clientId,
				familyId: id
			};
			const refreshTokenKeys = tokenKeys && tokenKeys.refreshToken || this.getTokenKeys().refreshToken;
			const refreshTokens = [];
			refreshTokenKeys.forEach((key) => {
				if (this.refreshTokenKeyMatchesFilter(key, refreshTokenFilter)) {
					const refreshToken = this.getRefreshTokenCredential(key, correlationId);
					if (refreshToken && this.credentialMatchesFilter(refreshToken, refreshTokenFilter)) refreshTokens.push(refreshToken);
				}
			});
			const numRefreshTokens = refreshTokens.length;
			if (numRefreshTokens < 1) {
				this.commonLogger.info("CacheManager:getRefreshToken - No refresh token found.");
				return null;
			}
			if (numRefreshTokens > 1 && performanceClient && correlationId) performanceClient.addFields({ multiMatchedRT: numRefreshTokens }, correlationId);
			this.commonLogger.info("CacheManager:getRefreshToken - returning refresh token");
			return refreshTokens[0];
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		*/
		refreshTokenKeyMatchesFilter(inputKey, filter) {
			const key = inputKey.toLowerCase();
			if (filter.familyId && key.indexOf(filter.familyId.toLowerCase()) === -1) return false;
			if (!filter.familyId && filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			return true;
		}
		/**
		* Retrieve AppMetadataEntity from cache
		*/
		readAppMetadataFromCache(environment) {
			const appMetadataFilter = {
				environment,
				clientId: this.clientId
			};
			const appMetadata = this.getAppMetadataFilteredBy(appMetadataFilter);
			const appMetadataEntries = Object.keys(appMetadata).map((key) => appMetadata[key]);
			const numAppMetadata = appMetadataEntries.length;
			if (numAppMetadata < 1) return null;
			else if (numAppMetadata > 1) throw createClientAuthError(multipleMatchingAppMetadata);
			return appMetadataEntries[0];
		}
		/**
		* Return the family_id value associated  with FOCI
		* @param environment
		* @param clientId
		*/
		isAppMetadataFOCI(environment) {
			const appMetadata = this.readAppMetadataFromCache(environment);
			return !!(appMetadata && appMetadata.familyId === THE_FAMILY_ID);
		}
		/**
		* helper to match account ids
		* @param value
		* @param homeAccountId
		*/
		matchHomeAccountId(entity, homeAccountId) {
			return !!(typeof entity.homeAccountId === "string" && homeAccountId === entity.homeAccountId);
		}
		/**
		* helper to match account ids
		* @param entity
		* @param localAccountId
		* @returns
		*/
		matchLocalAccountIdFromTokenClaims(tokenClaims, localAccountId) {
			return localAccountId === (tokenClaims.oid || tokenClaims.sub);
		}
		matchLocalAccountIdFromTenantProfile(tenantProfile, localAccountId) {
			return tenantProfile.localAccountId === localAccountId;
		}
		/**
		* helper to match names
		* @param entity
		* @param name
		* @returns true if the downcased name properties are present and match in the filter and the entity
		*/
		matchName(claims, name) {
			return !!(name.toLowerCase() === claims.name?.toLowerCase());
		}
		/**
		* helper to match usernames
		* @param entity
		* @param username
		* @returns
		*/
		matchUsername(cachedUsername, filterUsername) {
			return !!(cachedUsername && typeof cachedUsername === "string" && filterUsername?.toLowerCase() === cachedUsername.toLowerCase());
		}
		/**
		* helper to match assertion
		* @param value
		* @param oboAssertion
		*/
		matchUserAssertionHash(entity, userAssertionHash) {
			return !!(entity.userAssertionHash && userAssertionHash === entity.userAssertionHash);
		}
		/**
		* helper to match environment
		* @param value
		* @param environment
		*/
		matchEnvironment(entity, environment) {
			if (this.staticAuthorityOptions) {
				const staticAliases = getAliasesFromStaticSources(this.staticAuthorityOptions, this.commonLogger);
				if (staticAliases.includes(environment) && staticAliases.includes(entity.environment)) return true;
			}
			const cloudMetadata = this.getAuthorityMetadataByAlias(environment);
			if (cloudMetadata && cloudMetadata.aliases.indexOf(entity.environment) > -1) return true;
			return false;
		}
		/**
		* helper to match credential type
		* @param entity
		* @param credentialType
		*/
		matchCredentialType(entity, credentialType) {
			return entity.credentialType && credentialType.toLowerCase() === entity.credentialType.toLowerCase();
		}
		/**
		* helper to match client ids
		* @param entity
		* @param clientId
		*/
		matchClientId(entity, clientId) {
			return !!(entity.clientId && clientId === entity.clientId);
		}
		/**
		* helper to match family ids
		* @param entity
		* @param familyId
		*/
		matchFamilyId(entity, familyId) {
			return !!(entity.familyId && familyId === entity.familyId);
		}
		/**
		* helper to match realm
		* @param entity
		* @param realm
		*/
		matchRealm(entity, realm) {
			return !!(entity.realm?.toLowerCase() === realm.toLowerCase());
		}
		/**
		* helper to match nativeAccountId
		* @param entity
		* @param nativeAccountId
		* @returns boolean indicating the match result
		*/
		matchNativeAccountId(entity, nativeAccountId) {
			return !!(entity.nativeAccountId && nativeAccountId === entity.nativeAccountId);
		}
		/**
		* helper to match loginHint which can be either:
		* 1. login_hint ID token claim
		* 2. username in cached account object
		* 3. upn in ID token claims
		* @param entity
		* @param loginHint
		* @returns
		*/
		matchLoginHintFromTokenClaims(tokenClaims, loginHint) {
			if (tokenClaims.login_hint === loginHint) return true;
			if (tokenClaims.preferred_username === loginHint) return true;
			if (tokenClaims.upn === loginHint) return true;
			return false;
		}
		/**
		* Helper to match sid
		* @param entity
		* @param sid
		* @returns true if the sid claim is present and matches the filter
		*/
		matchSid(idTokenClaims, sid) {
			return idTokenClaims.sid === sid;
		}
		matchAuthorityType(entity, authorityType) {
			return !!(entity.authorityType && authorityType.toLowerCase() === entity.authorityType.toLowerCase());
		}
		/**
		* Returns true if the target scopes are a subset of the current entity's scopes, false otherwise.
		* @param entity
		* @param target
		*/
		matchTarget(entity, target) {
			if (entity.credentialType !== CredentialType.ACCESS_TOKEN && entity.credentialType !== CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME || !entity.target) return false;
			return ScopeSet.fromString(entity.target).containsScopeSet(target);
		}
		/**
		* Returns true if the credential's tokenType or Authentication Scheme matches the one in the request, false otherwise
		* @param entity
		* @param tokenType
		*/
		matchTokenType(entity, tokenType) {
			return !!(entity.tokenType && entity.tokenType === tokenType);
		}
		/**
		* Returns true if the credential's keyId matches the one in the request, false otherwise
		* @param entity
		* @param keyId
		*/
		matchKeyId(entity, keyId) {
			return !!(entity.keyId && entity.keyId === keyId);
		}
		/**
		* returns if a given cache entity is of the type appmetadata
		* @param key
		*/
		isAppMetadata(key) {
			return key.indexOf(APP_METADATA) !== -1;
		}
		/**
		* returns if a given cache entity is of the type authoritymetadata
		* @param key
		*/
		isAuthorityMetadata(key) {
			return key.indexOf(AUTHORITY_METADATA_CONSTANTS.CACHE_KEY) !== -1;
		}
		/**
		* returns cache key used for cloud instance metadata
		*/
		generateAuthorityMetadataCacheKey(authority) {
			return `${AUTHORITY_METADATA_CONSTANTS.CACHE_KEY}-${this.clientId}-${authority}`;
		}
		/**
		* Helper to convert serialized data to object
		* @param obj
		* @param json
		*/
		static toObject(obj, json) {
			for (const propertyName in json) obj[propertyName] = json[propertyName];
			return obj;
		}
	};
	/** @internal */
	var DefaultStorageClass = class extends CacheManager {
		async setAccount() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccount() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setIdTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getIdTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setAccessTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccessTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setRefreshTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getRefreshTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		setAppMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAppMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		setServerTelemetry() {
			throw createClientAuthError(methodNotImplemented);
		}
		getServerTelemetry() {
			throw createClientAuthError(methodNotImplemented);
		}
		setAuthorityMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAuthorityMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAuthorityMetadataKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		setThrottlingCache() {
			throw createClientAuthError(methodNotImplemented);
		}
		getThrottlingCache() {
			throw createClientAuthError(methodNotImplemented);
		}
		removeItem() {
			throw createClientAuthError(methodNotImplemented);
		}
		getKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccountKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		getTokenKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		generateCredentialKey() {
			throw createClientAuthError(methodNotImplemented);
		}
		generateAccountKey() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	var StubPerformanceMeasurement = class {
		startMeasurement() {}
		endMeasurement() {}
		flushMeasurement() {
			return null;
		}
	};
	var StubPerformanceClient = class {
		generateId() {
			return "callback-id";
		}
		startMeasurement(measureName, correlationId) {
			return {
				end: () => null,
				discard: () => {},
				add: () => {},
				increment: () => {},
				event: {
					eventId: this.generateId(),
					status: PerformanceEventStatus.InProgress,
					authority: "",
					libraryName: "",
					libraryVersion: "",
					clientId: "",
					name: measureName,
					startTimeMs: Date.now(),
					correlationId: correlationId || ""
				},
				measurement: new StubPerformanceMeasurement()
			};
		}
		startPerformanceMeasurement() {
			return new StubPerformanceMeasurement();
		}
		calculateQueuedTime() {
			return 0;
		}
		addQueueMeasurement() {}
		setPreQueueTime() {}
		endMeasurement() {
			return null;
		}
		discardMeasurements() {}
		removePerformanceCallback() {
			return true;
		}
		addPerformanceCallback() {
			return "";
		}
		emitEvents() {}
		addFields() {}
		incrementFields() {}
		cacheEventByCorrelationId() {}
	};
	const DEFAULT_SYSTEM_OPTIONS = {
		tokenRenewalOffsetSeconds: DEFAULT_TOKEN_RENEWAL_OFFSET_SEC,
		preventCorsPreflight: false
	};
	const DEFAULT_LOGGER_IMPLEMENTATION = {
		loggerCallback: () => {},
		piiLoggingEnabled: false,
		logLevel: exports.LogLevel.Info,
		correlationId: Constants.EMPTY_STRING
	};
	const DEFAULT_CACHE_OPTIONS = { claimsBasedCachingEnabled: false };
	const DEFAULT_NETWORK_IMPLEMENTATION = {
		async sendGetRequestAsync() {
			throw createClientAuthError(methodNotImplemented);
		},
		async sendPostRequestAsync() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	const DEFAULT_LIBRARY_INFO = {
		sku: Constants.SKU,
		version,
		cpu: Constants.EMPTY_STRING,
		os: Constants.EMPTY_STRING
	};
	const DEFAULT_CLIENT_CREDENTIALS = {
		clientSecret: Constants.EMPTY_STRING,
		clientAssertion: void 0
	};
	const DEFAULT_AZURE_CLOUD_OPTIONS = {
		azureCloudInstance: AzureCloudInstance.None,
		tenant: `${Constants.DEFAULT_COMMON_TENANT}`
	};
	const DEFAULT_TELEMETRY_OPTIONS = { application: {
		appName: "",
		appVersion: ""
	} };
	/**
	* Function that sets the default options when not explicitly configured from app developer
	*
	* @param Configuration
	*
	* @returns Configuration
	*/
	function buildClientConfiguration({ authOptions: userAuthOptions, systemOptions: userSystemOptions, loggerOptions: userLoggerOption, cacheOptions: userCacheOptions, storageInterface: storageImplementation, networkInterface: networkImplementation, cryptoInterface: cryptoImplementation, clientCredentials, libraryInfo, telemetry, serverTelemetryManager, persistencePlugin, serializableCache }) {
		const loggerOptions = {
			...DEFAULT_LOGGER_IMPLEMENTATION,
			...userLoggerOption
		};
		return {
			authOptions: buildAuthOptions(userAuthOptions),
			systemOptions: {
				...DEFAULT_SYSTEM_OPTIONS,
				...userSystemOptions
			},
			loggerOptions,
			cacheOptions: {
				...DEFAULT_CACHE_OPTIONS,
				...userCacheOptions
			},
			storageInterface: storageImplementation || new DefaultStorageClass(userAuthOptions.clientId, DEFAULT_CRYPTO_IMPLEMENTATION, new Logger(loggerOptions), new StubPerformanceClient()),
			networkInterface: networkImplementation || DEFAULT_NETWORK_IMPLEMENTATION,
			cryptoInterface: cryptoImplementation || DEFAULT_CRYPTO_IMPLEMENTATION,
			clientCredentials: clientCredentials || DEFAULT_CLIENT_CREDENTIALS,
			libraryInfo: {
				...DEFAULT_LIBRARY_INFO,
				...libraryInfo
			},
			telemetry: {
				...DEFAULT_TELEMETRY_OPTIONS,
				...telemetry
			},
			serverTelemetryManager: serverTelemetryManager || null,
			persistencePlugin: persistencePlugin || null,
			serializableCache: serializableCache || null
		};
	}
	/**
	* Construct authoptions from the client and platform passed values
	* @param authOptions
	*/
	function buildAuthOptions(authOptions) {
		return {
			clientCapabilities: [],
			azureCloudOptions: DEFAULT_AZURE_CLOUD_OPTIONS,
			skipAuthorityMetadataCache: false,
			instanceAware: false,
			encodeExtraQueryParams: false,
			...authOptions
		};
	}
	/**
	* Returns true if config has protocolMode set to ProtocolMode.OIDC, false otherwise
	* @param ClientConfiguration
	*/
	function isOidcProtocolMode(config) {
		return config.authOptions.authority.options.protocolMode === ProtocolMode.OIDC;
	}
	const CcsCredentialType = {
		HOME_ACCOUNT_ID: "home_account_id",
		UPN: "UPN"
	};
	function instrumentBrokerParams(parameters, correlationId, performanceClient) {
		if (!correlationId) return;
		const clientId = parameters.get(CLIENT_ID);
		if (clientId && parameters.has(BROKER_CLIENT_ID)) performanceClient?.addFields({
			embeddedClientId: clientId,
			embeddedRedirectUri: parameters.get(REDIRECT_URI)
		}, correlationId);
	}
	/**
	* Add the given response_type
	* @param parameters
	* @param responseType
	*/
	function addResponseType(parameters, responseType) {
		parameters.set(RESPONSE_TYPE, responseType);
	}
	/**
	* add response_mode. defaults to query.
	* @param responseMode
	*/
	function addResponseMode(parameters, responseMode) {
		parameters.set(RESPONSE_MODE, responseMode ? responseMode : ResponseMode.QUERY);
	}
	/**
	* Add flag to indicate STS should attempt to use WAM if available
	*/
	function addNativeBroker(parameters) {
		parameters.set(NATIVE_BROKER, "1");
	}
	/**
	* add scopes. set addOidcScopes to false to prevent default scopes in non-user scenarios
	* @param scopeSet
	* @param addOidcScopes
	*/
	function addScopes(parameters, scopes, addOidcScopes = true, defaultScopes = OIDC_DEFAULT_SCOPES) {
		if (addOidcScopes && !defaultScopes.includes("openid") && !scopes.includes("openid")) defaultScopes.push("openid");
		const scopeSet = new ScopeSet(addOidcScopes ? [...scopes || [], ...defaultScopes] : scopes || []);
		parameters.set(SCOPE, scopeSet.printScopes());
	}
	/**
	* add clientId
	* @param clientId
	*/
	function addClientId(parameters, clientId) {
		parameters.set(CLIENT_ID, clientId);
	}
	/**
	* add redirect_uri
	* @param redirectUri
	*/
	function addRedirectUri(parameters, redirectUri) {
		parameters.set(REDIRECT_URI, redirectUri);
	}
	/**
	* add post logout redirectUri
	* @param redirectUri
	*/
	function addPostLogoutRedirectUri(parameters, redirectUri) {
		parameters.set(POST_LOGOUT_URI, redirectUri);
	}
	/**
	* add id_token_hint to logout request
	* @param idTokenHint
	*/
	function addIdTokenHint(parameters, idTokenHint) {
		parameters.set(ID_TOKEN_HINT, idTokenHint);
	}
	/**
	* add domain_hint
	* @param domainHint
	*/
	function addDomainHint(parameters, domainHint) {
		parameters.set(DOMAIN_HINT, domainHint);
	}
	/**
	* add login_hint
	* @param loginHint
	*/
	function addLoginHint(parameters, loginHint) {
		parameters.set(LOGIN_HINT, loginHint);
	}
	/**
	* Adds the CCS (Cache Credential Service) query parameter for login_hint
	* @param loginHint
	*/
	function addCcsUpn(parameters, loginHint) {
		parameters.set(HeaderNames.CCS_HEADER, `UPN:${loginHint}`);
	}
	/**
	* Adds the CCS (Cache Credential Service) query parameter for account object
	* @param loginHint
	*/
	function addCcsOid(parameters, clientInfo) {
		parameters.set(HeaderNames.CCS_HEADER, `Oid:${clientInfo.uid}@${clientInfo.utid}`);
	}
	/**
	* add sid
	* @param sid
	*/
	function addSid(parameters, sid) {
		parameters.set(SID, sid);
	}
	/**
	* add claims
	* @param claims
	*/
	function addClaims(parameters, claims, clientCapabilities) {
		const mergedClaims = addClientCapabilitiesToClaims(claims, clientCapabilities);
		try {
			JSON.parse(mergedClaims);
		} catch (e) {
			throw createClientConfigurationError(invalidClaims);
		}
		parameters.set(CLAIMS, mergedClaims);
	}
	/**
	* add correlationId
	* @param correlationId
	*/
	function addCorrelationId(parameters, correlationId) {
		parameters.set(CLIENT_REQUEST_ID, correlationId);
	}
	/**
	* add library info query params
	* @param libraryInfo
	*/
	function addLibraryInfo(parameters, libraryInfo) {
		parameters.set(X_CLIENT_SKU, libraryInfo.sku);
		parameters.set(X_CLIENT_VER, libraryInfo.version);
		if (libraryInfo.os) parameters.set(X_CLIENT_OS, libraryInfo.os);
		if (libraryInfo.cpu) parameters.set(X_CLIENT_CPU, libraryInfo.cpu);
	}
	/**
	* Add client telemetry parameters
	* @param appTelemetry
	*/
	function addApplicationTelemetry(parameters, appTelemetry) {
		if (appTelemetry?.appName) parameters.set(X_APP_NAME, appTelemetry.appName);
		if (appTelemetry?.appVersion) parameters.set(X_APP_VER, appTelemetry.appVersion);
	}
	/**
	* add prompt
	* @param prompt
	*/
	function addPrompt(parameters, prompt) {
		parameters.set(PROMPT, prompt);
	}
	/**
	* add state
	* @param state
	*/
	function addState(parameters, state) {
		if (state) parameters.set(STATE, state);
	}
	/**
	* add nonce
	* @param nonce
	*/
	function addNonce(parameters, nonce) {
		parameters.set(NONCE, nonce);
	}
	/**
	* add code_challenge and code_challenge_method
	* - throw if either of them are not passed
	* @param codeChallenge
	* @param codeChallengeMethod
	*/
	function addCodeChallengeParams(parameters, codeChallenge, codeChallengeMethod) {
		if (codeChallenge && codeChallengeMethod) {
			parameters.set(CODE_CHALLENGE, codeChallenge);
			parameters.set(CODE_CHALLENGE_METHOD, codeChallengeMethod);
		} else throw createClientConfigurationError(pkceParamsMissing);
	}
	/**
	* add the `authorization_code` passed by the user to exchange for a token
	* @param code
	*/
	function addAuthorizationCode(parameters, code) {
		parameters.set(CODE, code);
	}
	/**
	* add the `authorization_code` passed by the user to exchange for a token
	* @param code
	*/
	function addDeviceCode(parameters, code) {
		parameters.set(DEVICE_CODE, code);
	}
	/**
	* add the `refreshToken` passed by the user
	* @param refreshToken
	*/
	function addRefreshToken(parameters, refreshToken) {
		parameters.set(REFRESH_TOKEN, refreshToken);
	}
	/**
	* add the `code_verifier` passed by the user to exchange for a token
	* @param codeVerifier
	*/
	function addCodeVerifier(parameters, codeVerifier) {
		parameters.set(CODE_VERIFIER, codeVerifier);
	}
	/**
	* add client_secret
	* @param clientSecret
	*/
	function addClientSecret(parameters, clientSecret) {
		parameters.set(CLIENT_SECRET, clientSecret);
	}
	/**
	* add clientAssertion for confidential client flows
	* @param clientAssertion
	*/
	function addClientAssertion(parameters, clientAssertion) {
		if (clientAssertion) parameters.set(CLIENT_ASSERTION, clientAssertion);
	}
	/**
	* add clientAssertionType for confidential client flows
	* @param clientAssertionType
	*/
	function addClientAssertionType(parameters, clientAssertionType) {
		if (clientAssertionType) parameters.set(CLIENT_ASSERTION_TYPE, clientAssertionType);
	}
	/**
	* add OBO assertion for confidential client flows
	* @param clientAssertion
	*/
	function addOboAssertion(parameters, oboAssertion) {
		parameters.set(OBO_ASSERTION, oboAssertion);
	}
	/**
	* add grant type
	* @param grantType
	*/
	function addRequestTokenUse(parameters, tokenUse) {
		parameters.set(REQUESTED_TOKEN_USE, tokenUse);
	}
	/**
	* add grant type
	* @param grantType
	*/
	function addGrantType(parameters, grantType) {
		parameters.set(GRANT_TYPE, grantType);
	}
	/**
	* add client info
	*
	*/
	function addClientInfo(parameters) {
		parameters.set(CLIENT_INFO$1, "1");
	}
	/**
	* add clidata=1 to request to indicate client data support
	*/
	function addCliData(parameters) {
		parameters.set(CLI_DATA, "1");
	}
	function addInstanceAware(parameters) {
		if (!parameters.has(INSTANCE_AWARE)) parameters.set(INSTANCE_AWARE, "true");
	}
	/**
	* add extraQueryParams
	* @param eQParams
	*/
	function addExtraQueryParameters(parameters, eQParams) {
		Object.entries(eQParams).forEach(([key, value]) => {
			if (!parameters.has(key) && value) parameters.set(key, value);
		});
	}
	function addClientCapabilitiesToClaims(claims, clientCapabilities) {
		let mergedClaims;
		if (!claims) mergedClaims = {};
		else try {
			mergedClaims = JSON.parse(claims);
		} catch (e) {
			throw createClientConfigurationError(invalidClaims);
		}
		if (clientCapabilities && clientCapabilities.length > 0) {
			if (!mergedClaims.hasOwnProperty(ClaimsRequestKeys.ACCESS_TOKEN)) mergedClaims[ClaimsRequestKeys.ACCESS_TOKEN] = {};
			mergedClaims[ClaimsRequestKeys.ACCESS_TOKEN][ClaimsRequestKeys.XMS_CC] = { values: clientCapabilities };
		}
		return JSON.stringify(mergedClaims);
	}
	/**
	* adds `username` for Password Grant flow
	* @param username
	*/
	function addUsername(parameters, username) {
		parameters.set(PasswordGrantConstants.username, username);
	}
	/**
	* adds `password` for Password Grant flow
	* @param password
	*/
	function addPassword(parameters, password) {
		parameters.set(PasswordGrantConstants.password, password);
	}
	/**
	* add pop_jwk to query params
	* @param cnfString
	*/
	function addPopToken(parameters, cnfString) {
		if (cnfString) {
			parameters.set(TOKEN_TYPE, AuthenticationScheme.POP);
			parameters.set(REQ_CNF, cnfString);
		}
	}
	/**
	* add SSH JWK and key ID to query params
	*/
	function addSshJwk(parameters, sshJwkString) {
		if (sshJwkString) {
			parameters.set(TOKEN_TYPE, AuthenticationScheme.SSH);
			parameters.set(REQ_CNF, sshJwkString);
		}
	}
	/**
	* add server telemetry fields
	* @param serverTelemetryManager
	*/
	function addServerTelemetry(parameters, serverTelemetryManager) {
		parameters.set(X_CLIENT_CURR_TELEM, serverTelemetryManager.generateCurrentRequestHeaderValue());
		parameters.set(X_CLIENT_LAST_TELEM, serverTelemetryManager.generateLastRequestHeaderValue());
	}
	/**
	* Adds parameter that indicates to the server that throttling is supported
	*/
	function addThrottling(parameters) {
		parameters.set(X_MS_LIB_CAPABILITY, ThrottlingConstants.X_MS_LIB_CAPABILITY_VALUE);
	}
	/**
	* Adds logout_hint parameter for "silent" logout which prevent server account picker
	*/
	function addLogoutHint(parameters, logoutHint) {
		parameters.set(LOGOUT_HINT, logoutHint);
	}
	function addBrokerParameters(parameters, brokerClientId, brokerRedirectUri) {
		if (!parameters.has(BROKER_CLIENT_ID)) parameters.set(BROKER_CLIENT_ID, brokerClientId);
		if (!parameters.has(BROKER_REDIRECT_URI)) parameters.set(BROKER_REDIRECT_URI, brokerRedirectUri);
	}
	/**
	* Add EAR (Encrypted Authorize Response) request parameters
	* @param parameters
	* @param jwk
	*/
	function addEARParameters(parameters, jwk) {
		parameters.set(EAR_JWK, encodeURIComponent(jwk));
		parameters.set(EAR_JWE_CRYPTO, "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0");
	}
	/**
	* Adds authorize body parameters to the request parameters
	* @param parameters
	* @param bodyParameters
	*/
	function addPostBodyParameters(parameters, bodyParameters) {
		Object.entries(bodyParameters).forEach(([key, value]) => {
			if (value) parameters.set(key, value);
		});
	}
	var RequestParameterBuilder = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		addApplicationTelemetry,
		addAuthorizationCode,
		addBrokerParameters,
		addCcsOid,
		addCcsUpn,
		addClaims,
		addCliData,
		addClientAssertion,
		addClientAssertionType,
		addClientCapabilitiesToClaims,
		addClientId,
		addClientInfo,
		addClientSecret,
		addCodeChallengeParams,
		addCodeVerifier,
		addCorrelationId,
		addDeviceCode,
		addDomainHint,
		addEARParameters,
		addExtraQueryParameters,
		addGrantType,
		addIdTokenHint,
		addInstanceAware,
		addLibraryInfo,
		addLoginHint,
		addLogoutHint,
		addNativeBroker,
		addNonce,
		addOboAssertion,
		addPassword,
		addPopToken,
		addPostBodyParameters,
		addPostLogoutRedirectUri,
		addPrompt,
		addRedirectUri,
		addRefreshToken,
		addRequestTokenUse,
		addResponseMode,
		addResponseType,
		addScopes,
		addServerTelemetry,
		addSid,
		addSshJwk,
		addState,
		addThrottling,
		addUsername,
		instrumentBrokerParams
	});
	/**
	* Error thrown when there is an error with the server code, for example, unavailability.
	*/
	var ServerError = class ServerError extends AuthError {
		constructor(errorCode, errorMessage, subError, errorNo, status) {
			super(errorCode, errorMessage, subError);
			this.name = "ServerError";
			this.errorNo = errorNo;
			this.status = status;
			Object.setPrototypeOf(this, ServerError.prototype);
		}
	};
	function getRequestThumbprint(clientId, request, homeAccountId) {
		return {
			clientId,
			authority: request.authority,
			scopes: request.scopes,
			homeAccountIdentifier: homeAccountId,
			claims: request.claims,
			authenticationScheme: request.authenticationScheme,
			resourceRequestMethod: request.resourceRequestMethod,
			resourceRequestUri: request.resourceRequestUri,
			shrClaims: request.shrClaims,
			sshKid: request.sshKid,
			embeddedClientId: request.embeddedClientId || request.tokenBodyParameters?.clientId
		};
	}
	/** @internal */
	var ThrottlingUtils = class ThrottlingUtils {
		/**
		* Prepares a RequestThumbprint to be stored as a key.
		* @param thumbprint
		*/
		static generateThrottlingStorageKey(thumbprint) {
			return `${ThrottlingConstants.THROTTLING_PREFIX}.${JSON.stringify(thumbprint)}`;
		}
		/**
		* Performs necessary throttling checks before a network request.
		* @param cacheManager
		* @param thumbprint
		*/
		static preProcess(cacheManager, thumbprint, correlationId) {
			const key = ThrottlingUtils.generateThrottlingStorageKey(thumbprint);
			const value = cacheManager.getThrottlingCache(key);
			if (value) {
				if (value.throttleTime < Date.now()) {
					cacheManager.removeItem(key, correlationId);
					return;
				}
				throw new ServerError(value.errorCodes?.join(" ") || Constants.EMPTY_STRING, value.errorMessage, value.subError);
			}
		}
		/**
		* Performs necessary throttling checks after a network request.
		* @param cacheManager
		* @param thumbprint
		* @param response
		*/
		static postProcess(cacheManager, thumbprint, response, correlationId) {
			if (ThrottlingUtils.checkResponseStatus(response) || ThrottlingUtils.checkResponseForRetryAfter(response)) {
				const thumbprintValue = {
					throttleTime: ThrottlingUtils.calculateThrottleTime(parseInt(response.headers[HeaderNames.RETRY_AFTER])),
					error: response.body.error,
					errorCodes: response.body.error_codes,
					errorMessage: response.body.error_description,
					subError: response.body.suberror
				};
				cacheManager.setThrottlingCache(ThrottlingUtils.generateThrottlingStorageKey(thumbprint), thumbprintValue, correlationId);
			}
		}
		/**
		* Checks a NetworkResponse object's status codes against 429 or 5xx
		* @param response
		*/
		static checkResponseStatus(response) {
			return response.status === 429 || response.status >= 500 && response.status < 600;
		}
		/**
		* Checks a NetworkResponse object's RetryAfter header
		* @param response
		*/
		static checkResponseForRetryAfter(response) {
			if (response.headers) return response.headers.hasOwnProperty(HeaderNames.RETRY_AFTER) && (response.status < 200 || response.status >= 300);
			return false;
		}
		/**
		* Calculates the Unix-time value for a throttle to expire given throttleTime in seconds.
		* @param throttleTime
		*/
		static calculateThrottleTime(throttleTime) {
			const time = throttleTime <= 0 ? 0 : throttleTime;
			const currentSeconds = Date.now() / 1e3;
			return Math.floor(Math.min(currentSeconds + (time || ThrottlingConstants.DEFAULT_THROTTLE_TIME_SECONDS), currentSeconds + ThrottlingConstants.DEFAULT_MAX_THROTTLE_TIME_SECONDS) * 1e3);
		}
		static removeThrottle(cacheManager, clientId, request, homeAccountIdentifier) {
			const thumbprint = getRequestThumbprint(clientId, request, homeAccountIdentifier);
			const key = this.generateThrottlingStorageKey(thumbprint);
			cacheManager.removeItem(key, request.correlationId);
		}
	};
	/**
	* Represents network related errors
	*/
	var NetworkError = class NetworkError extends AuthError {
		constructor(error, httpStatus, responseHeaders) {
			super(error.errorCode, error.errorMessage, error.subError);
			Object.setPrototypeOf(this, NetworkError.prototype);
			this.name = "NetworkError";
			this.error = error;
			this.httpStatus = httpStatus;
			this.responseHeaders = responseHeaders;
		}
	};
	/**
	* Creates NetworkError object for a failed network request
	* @param error - Error to be thrown back to the caller
	* @param httpStatus - Status code of the network request
	* @param responseHeaders - Response headers of the network request, when available
	* @returns NetworkError object
	*/
	function createNetworkError(error, httpStatus, responseHeaders, additionalError) {
		error.errorMessage = `${error.errorMessage}, additionalErrorInfo: error.name:${additionalError?.name}, error.message:${additionalError?.message}`;
		return new NetworkError(error, httpStatus, responseHeaders);
	}
	/**
	* Base application class which will construct requests to send to and handle responses from the Microsoft STS using the authorization code flow.
	* @internal
	*/
	var BaseClient = class {
		constructor(configuration, performanceClient) {
			this.config = buildClientConfiguration(configuration);
			this.logger = new Logger(this.config.loggerOptions, name, version);
			this.cryptoUtils = this.config.cryptoInterface;
			this.cacheManager = this.config.storageInterface;
			this.networkClient = this.config.networkInterface;
			this.serverTelemetryManager = this.config.serverTelemetryManager;
			this.authority = this.config.authOptions.authority;
			this.performanceClient = performanceClient;
		}
		/**
		* Creates default headers for requests to token endpoint
		*/
		createTokenRequestHeaders(ccsCred) {
			const headers = {};
			headers[HeaderNames.CONTENT_TYPE] = Constants.URL_FORM_CONTENT_TYPE;
			if (!this.config.systemOptions.preventCorsPreflight && ccsCred) switch (ccsCred.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						const clientInfo = buildClientInfoFromHomeAccountId(ccsCred.credential);
						headers[HeaderNames.CCS_HEADER] = `Oid:${clientInfo.uid}@${clientInfo.utid}`;
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					headers[HeaderNames.CCS_HEADER] = `UPN: ${ccsCred.credential}`;
					break;
			}
			return headers;
		}
		/**
		* Http post to token endpoint
		* @param tokenEndpoint
		* @param queryString
		* @param headers
		* @param thumbprint
		*/
		async executePostToTokenEndpoint(tokenEndpoint, queryString, headers, thumbprint, correlationId, queuedEvent) {
			if (queuedEvent) this.performanceClient?.addQueueMeasurement(queuedEvent, correlationId);
			const response = await this.sendPostRequest(thumbprint, tokenEndpoint, {
				body: queryString,
				headers
			}, correlationId);
			if (this.config.serverTelemetryManager && response.status < 500 && response.status !== 429) this.config.serverTelemetryManager.clearTelemetryCache();
			return response;
		}
		/**
		* Wraps sendPostRequestAsync with necessary preflight and postflight logic
		* @param thumbprint - Request thumbprint for throttling
		* @param tokenEndpoint - Endpoint to make the POST to
		* @param options - Body and Headers to include on the POST request
		* @param correlationId - CorrelationId for telemetry
		*/
		async sendPostRequest(thumbprint, tokenEndpoint, options, correlationId) {
			ThrottlingUtils.preProcess(this.cacheManager, thumbprint, correlationId);
			let response;
			try {
				response = await invokeAsync(this.networkClient.sendPostRequestAsync.bind(this.networkClient), PerformanceEvents.NetworkClientSendPostRequestAsync, this.logger, this.performanceClient, correlationId)(tokenEndpoint, options);
				const responseHeaders = response.headers || {};
				this.performanceClient?.addFields({
					refreshTokenSize: response.body.refresh_token?.length || 0,
					httpVerToken: responseHeaders[HeaderNames.X_MS_HTTP_VERSION] || "",
					requestId: responseHeaders[HeaderNames.X_MS_REQUEST_ID] || ""
				}, correlationId);
			} catch (e) {
				if (e instanceof NetworkError) {
					const responseHeaders = e.responseHeaders;
					if (responseHeaders) this.performanceClient?.addFields({
						httpVerToken: responseHeaders[HeaderNames.X_MS_HTTP_VERSION] || "",
						requestId: responseHeaders[HeaderNames.X_MS_REQUEST_ID] || "",
						contentTypeHeader: responseHeaders[HeaderNames.CONTENT_TYPE] || void 0,
						contentLengthHeader: responseHeaders[HeaderNames.CONTENT_LENGTH] || void 0,
						httpStatus: e.httpStatus
					}, correlationId);
					throw e.error;
				}
				if (e instanceof AuthError) throw e;
				else throw createClientAuthError(networkError);
			}
			ThrottlingUtils.postProcess(this.cacheManager, thumbprint, response, correlationId);
			return response;
		}
		/**
		* Updates the authority object of the client. Endpoint discovery must be completed.
		* @param updatedAuthority
		*/
		async updateAuthority(cloudInstanceHostname, correlationId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.UpdateTokenEndpointAuthority, correlationId);
			const cloudInstanceAuthority = await createDiscoveredInstance(`https://${cloudInstanceHostname}/${this.authority.tenant}/`, this.networkClient, this.cacheManager, this.authority.options, this.logger, correlationId, this.performanceClient);
			this.authority = cloudInstanceAuthority;
		}
		/**
		* Creates query string for the /token request
		* @param request
		*/
		createTokenQueryParameters(request) {
			const parameters = /* @__PURE__ */ new Map();
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenQueryParameters) addExtraQueryParameters(parameters, request.tokenQueryParameters);
			addCorrelationId(parameters, request.correlationId);
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			return mapToQueryString(parameters);
		}
	};
	/**
	* MSAL-defined interaction required error code indicating no tokens are found in cache.
	* @public
	*/
	const noTokensFound = "no_tokens_found";
	/**
	* MSAL-defined error code indicating a native account is unavailable on the platform.
	* @public
	*/
	const nativeAccountUnavailable = "native_account_unavailable";
	/**
	* MSAL-defined error code indicating the refresh token has expired and user interaction is needed.
	* @public
	*/
	const refreshTokenExpired = "refresh_token_expired";
	/**
	* MSAL-defined error code indicating UI/UX is not allowed (e.g., blocked by policy), requiring alternate interaction.
	* @public
	*/
	const uxNotAllowed = "ux_not_allowed";
	/**
	* Server-originated error code indicating interaction is required to complete the request.
	* @public
	*/
	const interactionRequired = "interaction_required";
	/**
	* Server-originated error code indicating user consent is required.
	* @public
	*/
	const consentRequired = "consent_required";
	/**
	* Server-originated error code indicating user login is required.
	* @public
	*/
	const loginRequired = "login_required";
	/**
	* Server-originated error code indicating the token is invalid or corrupted.
	* @public
	*/
	const badToken = "bad_token";
	/**
	* Server-originated error code indicating the user was interrupted and must reattempt the flow.
	* @public
	*/
	const interruptedUser = "interrupted_user";
	var InteractionRequiredAuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		badToken,
		consentRequired,
		interactionRequired,
		interruptedUser,
		loginRequired,
		nativeAccountUnavailable,
		noTokensFound,
		refreshTokenExpired,
		uxNotAllowed
	});
	/**
	* InteractionRequiredServerErrorMessage contains string constants used by error codes and messages returned by the server indicating interaction is required
	*/
	const InteractionRequiredServerErrorMessage = [
		interactionRequired,
		consentRequired,
		loginRequired,
		badToken,
		uxNotAllowed,
		interruptedUser
	];
	const InteractionRequiredAuthSubErrorMessage = [
		"message_only",
		"additional_action",
		"basic_action",
		"user_password_expired",
		"consent_required",
		"bad_token",
		"interrupted_user"
	];
	const InteractionRequiredAuthErrorMessages = {
		[noTokensFound]: "No refresh token found in the cache. Please sign-in.",
		[nativeAccountUnavailable]: "The requested account is not available in the native broker. It may have been deleted or logged out. Please sign-in again using an interactive API.",
		[refreshTokenExpired]: "Refresh token has expired.",
		[badToken]: "Identity provider returned bad_token due to an expired or invalid refresh token. Please invoke an interactive API to resolve.",
		[uxNotAllowed]: "`canShowUI` flag in Edge was set to false. User interaction required on web page. Please invoke an interactive API to resolve.",
		[interruptedUser]: "The user could not be authenticated due to an interrupted state. Please invoke an interactive API to resolve."
	};
	/**
	* Interaction required errors defined by the SDK
	* @deprecated Use InteractionRequiredAuthErrorCodes instead
	*/
	const InteractionRequiredAuthErrorMessage = {
		noTokensFoundError: {
			code: noTokensFound,
			desc: InteractionRequiredAuthErrorMessages[noTokensFound]
		},
		native_account_unavailable: {
			code: nativeAccountUnavailable,
			desc: InteractionRequiredAuthErrorMessages[nativeAccountUnavailable]
		},
		bad_token: {
			code: badToken,
			desc: InteractionRequiredAuthErrorMessages[badToken]
		},
		interrupted_user: {
			code: interruptedUser,
			desc: InteractionRequiredAuthErrorMessages[interruptedUser]
		}
	};
	/**
	* Error thrown when user interaction is required.
	*/
	var InteractionRequiredAuthError = class InteractionRequiredAuthError extends AuthError {
		constructor(errorCode, errorMessage, subError, timestamp, traceId, correlationId, claims, errorNo) {
			super(errorCode, errorMessage, subError);
			Object.setPrototypeOf(this, InteractionRequiredAuthError.prototype);
			this.timestamp = timestamp || Constants.EMPTY_STRING;
			this.traceId = traceId || Constants.EMPTY_STRING;
			this.correlationId = correlationId || Constants.EMPTY_STRING;
			this.claims = claims || Constants.EMPTY_STRING;
			this.name = "InteractionRequiredAuthError";
			this.errorNo = errorNo;
		}
	};
	/**
	* Helper function used to determine if an error thrown by the server requires interaction to resolve
	* @param errorCode
	* @param errorString
	* @param subError
	*/
	function isInteractionRequiredError(errorCode, errorString, subError) {
		const isInteractionRequiredErrorCode = !!errorCode && InteractionRequiredServerErrorMessage.indexOf(errorCode) > -1;
		const isInteractionRequiredSubError = !!subError && InteractionRequiredAuthSubErrorMessage.indexOf(subError) > -1;
		const isInteractionRequiredErrorDesc = !!errorString && InteractionRequiredServerErrorMessage.some((irErrorCode) => {
			return errorString.indexOf(irErrorCode) > -1;
		});
		return isInteractionRequiredErrorCode || isInteractionRequiredErrorDesc || isInteractionRequiredSubError;
	}
	/**
	* Creates an InteractionRequiredAuthError
	*/
	function createInteractionRequiredAuthError(errorCode) {
		return new InteractionRequiredAuthError(errorCode, InteractionRequiredAuthErrorMessages[errorCode]);
	}
	/**
	* Class which provides helpers for OAuth 2.0 protocol specific values
	*/
	var ProtocolUtils = class ProtocolUtils {
		/**
		* Appends user state with random guid, or returns random guid.
		* @param userState
		* @param randomGuid
		*/
		static setRequestState(cryptoObj, userState, meta) {
			const libraryState = ProtocolUtils.generateLibraryState(cryptoObj, meta);
			return userState ? `${libraryState}${Constants.RESOURCE_DELIM}${userState}` : libraryState;
		}
		/**
		* Generates the state value used by the common library.
		* @param randomGuid
		* @param cryptoObj
		*/
		static generateLibraryState(cryptoObj, meta) {
			if (!cryptoObj) throw createClientAuthError(noCryptoObject);
			const stateObj = { id: cryptoObj.createNewGuid() };
			if (meta) stateObj.meta = meta;
			const stateString = JSON.stringify(stateObj);
			return cryptoObj.base64Encode(stateString);
		}
		/**
		* Parses the state into the RequestStateObject, which contains the LibraryState info and the state passed by the user.
		* @param state
		* @param cryptoObj
		*/
		static parseRequestState(cryptoObj, state) {
			if (!cryptoObj) throw createClientAuthError(noCryptoObject);
			if (!state) throw createClientAuthError(invalidState);
			try {
				const splitState = state.split(Constants.RESOURCE_DELIM);
				const libraryState = splitState[0];
				const userState = splitState.length > 1 ? splitState.slice(1).join(Constants.RESOURCE_DELIM) : Constants.EMPTY_STRING;
				const libraryStateString = cryptoObj.base64Decode(libraryState);
				const libraryStateObj = JSON.parse(libraryStateString);
				return {
					userRequestState: userState || Constants.EMPTY_STRING,
					libraryState: libraryStateObj
				};
			} catch (e) {
				throw createClientAuthError(invalidState);
			}
		}
	};
	const KeyLocation = { SW: "sw" };
	/** @internal */
	var PopTokenGenerator = class {
		constructor(cryptoUtils, performanceClient) {
			this.cryptoUtils = cryptoUtils;
			this.performanceClient = performanceClient;
		}
		/**
		* Generates the req_cnf validated at the RP in the POP protocol for SHR parameters
		* and returns an object containing the keyid, the full req_cnf string and the req_cnf string hash
		* @param request
		* @returns
		*/
		async generateCnf(request, logger) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.PopTokenGenerateCnf, request.correlationId);
			const reqCnf = await invokeAsync(this.generateKid.bind(this), PerformanceEvents.PopTokenGenerateCnf, logger, this.performanceClient, request.correlationId)(request);
			const reqCnfString = this.cryptoUtils.base64UrlEncode(JSON.stringify(reqCnf));
			return {
				kid: reqCnf.kid,
				reqCnfString
			};
		}
		/**
		* Generates key_id for a SHR token request
		* @param request
		* @returns
		*/
		async generateKid(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.PopTokenGenerateKid, request.correlationId);
			return {
				kid: await this.cryptoUtils.getPublicKeyThumbprint(request),
				xms_ksl: KeyLocation.SW
			};
		}
		/**
		* Signs the POP access_token with the local generated key-pair
		* @param accessToken
		* @param request
		* @returns
		*/
		async signPopToken(accessToken, keyId, request) {
			return this.signPayload(accessToken, keyId, request);
		}
		/**
		* Utility function to generate the signed JWT for an access_token
		* @param payload
		* @param kid
		* @param request
		* @param claims
		* @returns
		*/
		async signPayload(payload, keyId, request, claims) {
			const { resourceRequestMethod, resourceRequestUri, shrClaims, shrNonce, shrOptions } = request;
			const resourceUrlComponents = (resourceRequestUri ? new UrlString(resourceRequestUri) : void 0)?.getUrlComponents();
			return this.cryptoUtils.signJwt({
				at: payload,
				ts: nowSeconds(),
				m: resourceRequestMethod?.toUpperCase(),
				u: resourceUrlComponents?.HostNameAndPort,
				nonce: shrNonce || this.cryptoUtils.createNewGuid(),
				p: resourceUrlComponents?.AbsolutePath,
				q: resourceUrlComponents?.QueryString ? [[], resourceUrlComponents.QueryString] : void 0,
				client_claims: shrClaims || void 0,
				...claims
			}, keyId, shrOptions, request.correlationId);
		}
	};
	/**
	* This class instance helps track the memory changes facilitating
	* decisions to read from and write to the persistent cache
	*/ var TokenCacheContext = class {
		constructor(tokenCache, hasChanged) {
			this.cache = tokenCache;
			this.hasChanged = hasChanged;
		}
		/**
		* boolean which indicates the changes in cache
		*/
		get cacheHasChanged() {
			return this.hasChanged;
		}
		/**
		* function to retrieve the token cache
		*/
		get tokenCache() {
			return this.cache;
		}
	};
	/**
	* Class that handles response parsing.
	* @internal
	*/
	var ResponseHandler = class ResponseHandler {
		constructor(clientId, cacheStorage, cryptoObj, logger, serializableCache, persistencePlugin, performanceClient) {
			this.clientId = clientId;
			this.cacheStorage = cacheStorage;
			this.cryptoObj = cryptoObj;
			this.logger = logger;
			this.serializableCache = serializableCache;
			this.persistencePlugin = persistencePlugin;
			this.performanceClient = performanceClient;
		}
		/**
		* Function which validates server authorization token response.
		* @param serverResponse
		* @param refreshAccessToken
		*/
		validateTokenResponse(serverResponse, refreshAccessToken) {
			if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
				const errString = `Error(s): ${serverResponse.error_codes || Constants.NOT_AVAILABLE} - Timestamp: ${serverResponse.timestamp || Constants.NOT_AVAILABLE} - Description: ${serverResponse.error_description || Constants.NOT_AVAILABLE} - Correlation ID: ${serverResponse.correlation_id || Constants.NOT_AVAILABLE} - Trace ID: ${serverResponse.trace_id || Constants.NOT_AVAILABLE}`;
				const serverErrorNo = serverResponse.error_codes?.length ? serverResponse.error_codes[0] : void 0;
				const serverError = new ServerError(serverResponse.error, errString, serverResponse.suberror, serverErrorNo, serverResponse.status);
				if (refreshAccessToken && serverResponse.status && serverResponse.status >= HttpStatus.SERVER_ERROR_RANGE_START && serverResponse.status <= HttpStatus.SERVER_ERROR_RANGE_END) {
					this.logger.warning(`executeTokenRequest:validateTokenResponse - AAD is currently unavailable and the access token is unable to be refreshed.\n${serverError}`);
					return;
				} else if (refreshAccessToken && serverResponse.status && serverResponse.status >= HttpStatus.CLIENT_ERROR_RANGE_START && serverResponse.status <= HttpStatus.CLIENT_ERROR_RANGE_END) {
					this.logger.warning(`executeTokenRequest:validateTokenResponse - AAD is currently available but is unable to refresh the access token.\n${serverError}`);
					return;
				}
				if (isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) throw new InteractionRequiredAuthError(serverResponse.error, serverResponse.error_description, serverResponse.suberror, serverResponse.timestamp || Constants.EMPTY_STRING, serverResponse.trace_id || Constants.EMPTY_STRING, serverResponse.correlation_id || Constants.EMPTY_STRING, serverResponse.claims || Constants.EMPTY_STRING, serverErrorNo);
				throw serverError;
			}
		}
		/**
		* Returns a constructed token response based on given string. Also manages the cache updates and cleanups.
		* @param serverTokenResponse
		* @param authority
		*/
		async handleServerTokenResponse(serverTokenResponse, authority, reqTimestamp, request, apiId, authCodePayload, userAssertionHash, handlingRefreshTokenResponse, forceCacheRefreshTokenResponse, serverRequestId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.HandleServerTokenResponse, serverTokenResponse.correlation_id);
			let idTokenClaims;
			if (serverTokenResponse.id_token) {
				idTokenClaims = extractTokenClaims(serverTokenResponse.id_token || Constants.EMPTY_STRING, this.cryptoObj.base64Decode);
				if (authCodePayload && authCodePayload.nonce) {
					if (idTokenClaims.nonce !== authCodePayload.nonce) throw createClientAuthError(nonceMismatch);
				}
				if (request.maxAge || request.maxAge === 0) {
					const authTime = idTokenClaims.auth_time;
					if (!authTime) throw createClientAuthError(authTimeNotFound);
					checkMaxAge(authTime, request.maxAge);
				}
			}
			this.homeAccountIdentifier = AccountEntity.generateHomeAccountId(serverTokenResponse.client_info || Constants.EMPTY_STRING, authority.authorityType, this.logger, this.cryptoObj, idTokenClaims);
			let requestStateObj;
			if (!!authCodePayload && !!authCodePayload.state) requestStateObj = ProtocolUtils.parseRequestState(this.cryptoObj, authCodePayload.state);
			serverTokenResponse.key_id = serverTokenResponse.key_id || request.sshKid || void 0;
			const cacheRecord = this.generateCacheRecord(serverTokenResponse, authority, reqTimestamp, request, idTokenClaims, userAssertionHash, authCodePayload);
			let cacheContext;
			try {
				if (this.persistencePlugin && this.serializableCache) {
					this.logger.verbose("Persistence enabled, calling beforeCacheAccess");
					cacheContext = new TokenCacheContext(this.serializableCache, true);
					await this.persistencePlugin.beforeCacheAccess(cacheContext);
				}
				if (handlingRefreshTokenResponse && !forceCacheRefreshTokenResponse && cacheRecord.account) {
					if (this.cacheStorage.getAllAccounts({
						homeAccountId: cacheRecord.account.homeAccountId,
						environment: cacheRecord.account.environment
					}, request.correlationId).length < 1) {
						this.logger.warning("Account used to refresh tokens not in persistence, refreshed tokens will not be stored in the cache");
						this.performanceClient?.addFields({ acntLoggedOut: true }, request.correlationId);
						return await ResponseHandler.generateAuthenticationResult(this.cryptoObj, authority, cacheRecord, false, request, idTokenClaims, requestStateObj, void 0, serverRequestId);
					}
				}
				await this.cacheStorage.saveCacheRecord(cacheRecord, request.correlationId, isKmsi(idTokenClaims || {}), apiId, request.storeInCache);
			} finally {
				if (this.persistencePlugin && this.serializableCache && cacheContext) {
					this.logger.verbose("Persistence enabled, calling afterCacheAccess");
					await this.persistencePlugin.afterCacheAccess(cacheContext);
				}
			}
			return ResponseHandler.generateAuthenticationResult(this.cryptoObj, authority, cacheRecord, false, request, idTokenClaims, requestStateObj, serverTokenResponse, serverRequestId);
		}
		/**
		* Generates CacheRecord
		* @param serverTokenResponse
		* @param idTokenObj
		* @param authority
		*/
		generateCacheRecord(serverTokenResponse, authority, reqTimestamp, request, idTokenClaims, userAssertionHash, authCodePayload) {
			const env = authority.getPreferredCache();
			if (!env) throw createClientAuthError(invalidCacheEnvironment);
			const claimsTenantId = getTenantIdFromIdTokenClaims(idTokenClaims);
			let cachedIdToken;
			let cachedAccount;
			if (serverTokenResponse.id_token && !!idTokenClaims) {
				cachedIdToken = createIdTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.id_token, this.clientId, claimsTenantId || "");
				cachedAccount = buildAccountToCache(this.cacheStorage, authority, this.homeAccountIdentifier, this.cryptoObj.base64Decode, request.correlationId, idTokenClaims, serverTokenResponse.client_info, env, claimsTenantId, authCodePayload, void 0, this.logger);
			}
			let cachedAccessToken = null;
			if (serverTokenResponse.access_token) {
				const responseScopes = serverTokenResponse.scope ? ScopeSet.fromString(serverTokenResponse.scope) : new ScopeSet(request.scopes || []);
				const expiresIn = (typeof serverTokenResponse.expires_in === "string" ? parseInt(serverTokenResponse.expires_in, 10) : serverTokenResponse.expires_in) || 0;
				const extExpiresIn = (typeof serverTokenResponse.ext_expires_in === "string" ? parseInt(serverTokenResponse.ext_expires_in, 10) : serverTokenResponse.ext_expires_in) || 0;
				const refreshIn = (typeof serverTokenResponse.refresh_in === "string" ? parseInt(serverTokenResponse.refresh_in, 10) : serverTokenResponse.refresh_in) || void 0;
				const tokenExpirationSeconds = reqTimestamp + expiresIn;
				const extendedTokenExpirationSeconds = tokenExpirationSeconds + extExpiresIn;
				const refreshOnSeconds = refreshIn && refreshIn > 0 ? reqTimestamp + refreshIn : void 0;
				cachedAccessToken = createAccessTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.access_token, this.clientId, claimsTenantId || authority.tenant || "", responseScopes.printScopes(), tokenExpirationSeconds, extendedTokenExpirationSeconds, this.cryptoObj.base64Decode, refreshOnSeconds, serverTokenResponse.token_type, userAssertionHash, serverTokenResponse.key_id, request.claims, request.requestedClaimsHash);
			}
			let cachedRefreshToken = null;
			if (serverTokenResponse.refresh_token) {
				let rtExpiresOn;
				if (serverTokenResponse.refresh_token_expires_in) {
					rtExpiresOn = reqTimestamp + (typeof serverTokenResponse.refresh_token_expires_in === "string" ? parseInt(serverTokenResponse.refresh_token_expires_in, 10) : serverTokenResponse.refresh_token_expires_in);
					this.performanceClient?.addFields({ ntwkRtExpiresOnSeconds: rtExpiresOn }, request.correlationId);
				}
				cachedRefreshToken = createRefreshTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.refresh_token, this.clientId, serverTokenResponse.foci, userAssertionHash, rtExpiresOn);
			}
			let cachedAppMetadata = null;
			if (serverTokenResponse.foci) cachedAppMetadata = {
				clientId: this.clientId,
				environment: env,
				familyId: serverTokenResponse.foci
			};
			return {
				account: cachedAccount,
				idToken: cachedIdToken,
				accessToken: cachedAccessToken,
				refreshToken: cachedRefreshToken,
				appMetadata: cachedAppMetadata
			};
		}
		/**
		* Creates an @AuthenticationResult from @CacheRecord , @IdToken , and a boolean that states whether or not the result is from cache.
		*
		* Optionally takes a state string that is set as-is in the response.
		*
		* @param cacheRecord
		* @param idTokenObj
		* @param fromTokenCache
		* @param stateString
		*/
		static async generateAuthenticationResult(cryptoObj, authority, cacheRecord, fromTokenCache, request, idTokenClaims, requestState, serverTokenResponse, requestId) {
			let accessToken = Constants.EMPTY_STRING;
			let responseScopes = [];
			let expiresOn = null;
			let extExpiresOn;
			let refreshOn;
			let familyId = Constants.EMPTY_STRING;
			if (cacheRecord.accessToken) {
				if (cacheRecord.accessToken.tokenType === AuthenticationScheme.POP && !request.popKid) {
					const popTokenGenerator = new PopTokenGenerator(cryptoObj);
					const { secret, keyId } = cacheRecord.accessToken;
					if (!keyId) throw createClientAuthError(keyIdMissing);
					accessToken = await popTokenGenerator.signPopToken(secret, keyId, request);
				} else accessToken = cacheRecord.accessToken.secret;
				responseScopes = ScopeSet.fromString(cacheRecord.accessToken.target).asArray();
				expiresOn = toDateFromSeconds(cacheRecord.accessToken.expiresOn);
				extExpiresOn = toDateFromSeconds(cacheRecord.accessToken.extendedExpiresOn);
				if (cacheRecord.accessToken.refreshOn) refreshOn = toDateFromSeconds(cacheRecord.accessToken.refreshOn);
			}
			if (cacheRecord.appMetadata) familyId = cacheRecord.appMetadata.familyId === THE_FAMILY_ID ? THE_FAMILY_ID : "";
			const uid = idTokenClaims?.oid || idTokenClaims?.sub || "";
			const tid = idTokenClaims?.tid || "";
			if (serverTokenResponse?.spa_accountid && !!cacheRecord.account) cacheRecord.account.nativeAccountId = serverTokenResponse?.spa_accountid;
			const accountInfo = cacheRecord.account ? updateAccountTenantProfileData(AccountEntity.getAccountInfo(cacheRecord.account), void 0, idTokenClaims, cacheRecord.idToken?.secret) : null;
			return {
				authority: authority.canonicalAuthority,
				uniqueId: uid,
				tenantId: tid,
				scopes: responseScopes,
				account: accountInfo,
				idToken: cacheRecord?.idToken?.secret || "",
				idTokenClaims: idTokenClaims || {},
				accessToken,
				fromCache: fromTokenCache,
				expiresOn,
				extExpiresOn,
				refreshOn,
				correlationId: request.correlationId,
				requestId: requestId || Constants.EMPTY_STRING,
				familyId,
				tokenType: cacheRecord.accessToken?.tokenType || Constants.EMPTY_STRING,
				state: requestState ? requestState.userRequestState : Constants.EMPTY_STRING,
				cloudGraphHostName: cacheRecord.account?.cloudGraphHostName || Constants.EMPTY_STRING,
				msGraphHost: cacheRecord.account?.msGraphHost || Constants.EMPTY_STRING,
				code: serverTokenResponse?.spa_code,
				fromNativeBroker: false
			};
		}
	};
	function buildAccountToCache(cacheStorage, authority, homeAccountId, base64Decode, correlationId, idTokenClaims, clientInfo, environment, claimsTenantId, authCodePayload, nativeAccountId, logger) {
		logger?.verbose("setCachedAccount called");
		const baseAccountKey = cacheStorage.getAccountKeys().find((accountKey) => {
			return accountKey.startsWith(homeAccountId);
		});
		let cachedAccount = null;
		if (baseAccountKey) cachedAccount = cacheStorage.getAccount(baseAccountKey, correlationId);
		const baseAccount = cachedAccount || AccountEntity.createAccount({
			homeAccountId,
			idTokenClaims,
			clientInfo,
			environment,
			cloudGraphHostName: authCodePayload?.cloud_graph_host_name,
			msGraphHost: authCodePayload?.msgraph_host,
			nativeAccountId
		}, authority, base64Decode);
		const tenantProfiles = baseAccount.tenantProfiles || [];
		const tenantId = claimsTenantId || baseAccount.realm;
		if (tenantId && !tenantProfiles.find((tenantProfile) => {
			return tenantProfile.tenantId === tenantId;
		})) {
			const newTenantProfile = buildTenantProfile(homeAccountId, baseAccount.localAccountId, tenantId, idTokenClaims);
			tenantProfiles.push(newTenantProfile);
		}
		baseAccount.tenantProfiles = tenantProfiles;
		return baseAccount;
	}
	async function getClientAssertion(clientAssertion, clientId, tokenEndpoint) {
		if (typeof clientAssertion === "string") return clientAssertion;
		else return clientAssertion({
			clientId,
			tokenEndpoint
		});
	}
	var ClientAssertionUtils = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		getClientAssertion
	});
	/**
	* Oauth2.0 Authorization Code client
	* @internal
	*/
	var AuthorizationCodeClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
			this.includeRedirectUri = true;
			this.oidcDefaultScopes = this.config.authOptions.authority.options.OIDCOptions?.defaultScopes;
		}
		/**
		* API to acquire a token in exchange of 'authorization_code` acquired by the user in the first leg of the
		* authorization_code_grant
		* @param request
		* @param apiId - API identifier for telemetry tracking
		*/
		async acquireToken(request, apiId, authCodePayload) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientAcquireToken, request.correlationId);
			if (!request.code) throw createClientAuthError(requestCannotBeMade);
			const reqTimestamp = nowSeconds();
			const response = await invokeAsync(this.executeTokenRequest.bind(this), PerformanceEvents.AuthClientExecuteTokenRequest, this.logger, this.performanceClient, request.correlationId)(this.authority, request);
			const requestId = response.headers?.[HeaderNames.X_MS_REQUEST_ID];
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin, this.performanceClient);
			responseHandler.validateTokenResponse(response.body);
			return invokeAsync(responseHandler.handleServerTokenResponse.bind(responseHandler), PerformanceEvents.HandleServerTokenResponse, this.logger, this.performanceClient, request.correlationId)(response.body, this.authority, reqTimestamp, request, apiId, authCodePayload, void 0, void 0, void 0, requestId);
		}
		/**
		* Used to log out the current user, and redirect the user to the postLogoutRedirectUri.
		* Default behaviour is to redirect the user to `window.location.href`.
		* @param authorityUri
		*/
		getLogoutUri(logoutRequest) {
			if (!logoutRequest) throw createClientConfigurationError(logoutRequestEmpty);
			const queryString = this.createLogoutUrlQueryString(logoutRequest);
			return UrlString.appendQueryString(this.authority.endSessionEndpoint, queryString);
		}
		/**
		* Executes POST request to token endpoint
		* @param authority
		* @param request
		*/
		async executeTokenRequest(authority, request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientExecuteTokenRequest, request.correlationId);
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await invokeAsync(this.createTokenRequestBody.bind(this), PerformanceEvents.AuthClientCreateTokenRequestBody, this.logger, this.performanceClient, request.correlationId)(request);
			let ccsCredential = void 0;
			if (request.clientInfo) try {
				const clientInfo = buildClientInfo(request.clientInfo, this.cryptoUtils.base64Decode);
				ccsCredential = {
					credential: `${clientInfo.uid}${Separators.CLIENT_INFO_SEPARATOR}${clientInfo.utid}`,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				};
			} catch (e) {
				this.logger.verbose("Could not parse client info for CCS Header: " + e);
			}
			const headers = this.createTokenRequestHeaders(ccsCredential || request.ccsCredential);
			const thumbprint = getRequestThumbprint(this.config.authOptions.clientId, request);
			return invokeAsync(this.executePostToTokenEndpoint.bind(this), PerformanceEvents.AuthorizationCodeClientExecutePostToTokenEndpoint, this.logger, this.performanceClient, request.correlationId)(endpoint, requestBody, headers, thumbprint, request.correlationId, PerformanceEvents.AuthorizationCodeClientExecutePostToTokenEndpoint);
		}
		/**
		* Generates a map for all the params to be sent to the service
		* @param request
		*/
		async createTokenRequestBody(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientCreateTokenRequestBody, request.correlationId);
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, request.embeddedClientId || request.tokenBodyParameters?.[CLIENT_ID] || this.config.authOptions.clientId);
			if (!this.includeRedirectUri) {
				if (!request.redirectUri) throw createClientConfigurationError(redirectUriEmpty);
			} else addRedirectUri(parameters, request.redirectUri);
			addScopes(parameters, request.scopes, true, this.oidcDefaultScopes);
			addAuthorizationCode(parameters, request.code);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager && !isOidcProtocolMode(this.config)) addServerTelemetry(parameters, this.serverTelemetryManager);
			if (request.codeVerifier) addCodeVerifier(parameters, request.codeVerifier);
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			if (this.config.clientCredentials.clientAssertion) {
				const clientAssertion = this.config.clientCredentials.clientAssertion;
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			addGrantType(parameters, GrantType.AUTHORIZATION_CODE_GRANT);
			addClientInfo(parameters);
			if (request.authenticationScheme === AuthenticationScheme.POP) {
				const popTokenGenerator = new PopTokenGenerator(this.cryptoUtils, this.performanceClient);
				let reqCnfData;
				if (!request.popKid) reqCnfData = (await invokeAsync(popTokenGenerator.generateCnf.bind(popTokenGenerator), PerformanceEvents.PopTokenGenerateCnf, this.logger, this.performanceClient, request.correlationId)(request, this.logger)).reqCnfString;
				else reqCnfData = this.cryptoUtils.encodeKid(request.popKid);
				addPopToken(parameters, reqCnfData);
			} else if (request.authenticationScheme === AuthenticationScheme.SSH) if (request.sshJwk) addSshJwk(parameters, request.sshJwk);
			else throw createClientConfigurationError(missingSshJwk);
			let ccsCred = void 0;
			if (request.clientInfo) try {
				const clientInfo = buildClientInfo(request.clientInfo, this.cryptoUtils.base64Decode);
				ccsCred = {
					credential: `${clientInfo.uid}${Separators.CLIENT_INFO_SEPARATOR}${clientInfo.utid}`,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				};
			} catch (e) {
				this.logger.verbose("Could not parse client info for CCS Header: " + e);
			}
			else ccsCred = request.ccsCredential;
			if (this.config.systemOptions.preventCorsPreflight && ccsCred) switch (ccsCred.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(ccsCred.credential));
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					addCcsUpn(parameters, ccsCred.credential);
					break;
			}
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenBodyParameters) addExtraQueryParameters(parameters, request.tokenBodyParameters);
			if (request.enableSpaAuthorizationCode && (!request.tokenBodyParameters || !request.tokenBodyParameters[RETURN_SPA_CODE])) addExtraQueryParameters(parameters, { [RETURN_SPA_CODE]: "1" });
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : this.config.authOptions.clientCapabilities;
			if (!StringUtils.isEmptyObj(request.claims) || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
			return mapToQueryString(parameters);
		}
		/**
		* This API validates the `EndSessionRequest` and creates a URL
		* @param request
		*/
		createLogoutUrlQueryString(request) {
			const parameters = /* @__PURE__ */ new Map();
			if (request.postLogoutRedirectUri) addPostLogoutRedirectUri(parameters, request.postLogoutRedirectUri);
			if (request.correlationId) addCorrelationId(parameters, request.correlationId);
			if (request.idTokenHint) addIdTokenHint(parameters, request.idTokenHint);
			if (request.state) addState(parameters, request.state);
			if (request.logoutHint) addLogoutHint(parameters, request.logoutHint);
			if (request.extraQueryParameters) addExtraQueryParameters(parameters, request.extraQueryParameters);
			if (this.config.authOptions.instanceAware) addInstanceAware(parameters);
			return mapToQueryString(parameters, this.config.authOptions.encodeExtraQueryParams, request.extraQueryParameters);
		}
	};
	const DEFAULT_REFRESH_TOKEN_EXPIRATION_OFFSET_SECONDS = 300;
	/**
	* OAuth2.0 refresh token client
	* @internal
	*/
	var RefreshTokenClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
		}
		async acquireToken(request, apiId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireToken, request.correlationId);
			const reqTimestamp = nowSeconds();
			const response = await invokeAsync(this.executeTokenRequest.bind(this), PerformanceEvents.RefreshTokenClientExecuteTokenRequest, this.logger, this.performanceClient, request.correlationId)(request, this.authority);
			const requestId = response.headers?.[HeaderNames.X_MS_REQUEST_ID];
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(response.body);
			return invokeAsync(responseHandler.handleServerTokenResponse.bind(responseHandler), PerformanceEvents.HandleServerTokenResponse, this.logger, this.performanceClient, request.correlationId)(response.body, this.authority, reqTimestamp, request, apiId, void 0, void 0, true, request.forceCache, requestId);
		}
		/**
		* Gets cached refresh token and attaches to request, then calls acquireToken API
		* @param request
		*/
		async acquireTokenByRefreshToken(request, apiId) {
			if (!request) throw createClientConfigurationError(tokenRequestEmpty);
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireTokenByRefreshToken, request.correlationId);
			if (!request.account) throw createClientAuthError(noAccountInSilentRequest);
			if (this.cacheManager.isAppMetadataFOCI(request.account.environment)) try {
				return await invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, true, apiId);
			} catch (e) {
				const noFamilyRTInCache = e instanceof InteractionRequiredAuthError && e.errorCode === noTokensFound;
				const clientMismatchErrorWithFamilyRT = e instanceof ServerError && e.errorCode === Errors.INVALID_GRANT_ERROR && e.subError === Errors.CLIENT_MISMATCH_ERROR;
				if (noFamilyRTInCache || clientMismatchErrorWithFamilyRT) return invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, false, apiId);
				else throw e;
			}
			return invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, false, apiId);
		}
		/**
		* makes a network call to acquire tokens by exchanging RefreshToken available in userCache; throws if refresh token is not cached
		* @param request
		*/
		async acquireTokenWithCachedRefreshToken(request, foci, apiId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, request.correlationId);
			const refreshToken = invoke(this.cacheManager.getRefreshToken.bind(this.cacheManager), PerformanceEvents.CacheManagerGetRefreshToken, this.logger, this.performanceClient, request.correlationId)(request.account, foci, request.correlationId, void 0, this.performanceClient);
			if (!refreshToken) throw createInteractionRequiredAuthError(noTokensFound);
			if (refreshToken.expiresOn) {
				const offset = request.refreshTokenExpirationOffsetSeconds || DEFAULT_REFRESH_TOKEN_EXPIRATION_OFFSET_SECONDS;
				this.performanceClient?.addFields({
					cacheRtExpiresOnSeconds: Number(refreshToken.expiresOn),
					rtOffsetSeconds: offset
				}, request.correlationId);
				if (isTokenExpired(refreshToken.expiresOn, offset)) throw createInteractionRequiredAuthError(refreshTokenExpired);
			}
			const refreshTokenRequest = {
				...request,
				refreshToken: refreshToken.secret,
				authenticationScheme: request.authenticationScheme || AuthenticationScheme.BEARER,
				ccsCredential: {
					credential: request.account.homeAccountId,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				}
			};
			try {
				return await invokeAsync(this.acquireToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireToken, this.logger, this.performanceClient, request.correlationId)(refreshTokenRequest, apiId);
			} catch (e) {
				if (e instanceof InteractionRequiredAuthError) {
					if (e.subError === badToken) {
						this.logger.verbose("acquireTokenWithRefreshToken: bad refresh token, removing from cache");
						const badRefreshTokenKey = this.cacheManager.generateCredentialKey(refreshToken);
						this.cacheManager.removeRefreshToken(badRefreshTokenKey, request.correlationId);
					}
				}
				throw e;
			}
		}
		/**
		* Constructs the network message and makes a NW call to the underlying secure token service
		* @param request
		* @param authority
		*/
		async executeTokenRequest(request, authority) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientExecuteTokenRequest, request.correlationId);
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await invokeAsync(this.createTokenRequestBody.bind(this), PerformanceEvents.RefreshTokenClientCreateTokenRequestBody, this.logger, this.performanceClient, request.correlationId)(request);
			const headers = this.createTokenRequestHeaders(request.ccsCredential);
			const thumbprint = getRequestThumbprint(this.config.authOptions.clientId, request);
			return invokeAsync(this.executePostToTokenEndpoint.bind(this), PerformanceEvents.RefreshTokenClientExecutePostToTokenEndpoint, this.logger, this.performanceClient, request.correlationId)(endpoint, requestBody, headers, thumbprint, request.correlationId, PerformanceEvents.RefreshTokenClientExecutePostToTokenEndpoint);
		}
		/**
		* Helper function to create the token request body
		* @param request
		*/
		async createTokenRequestBody(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientCreateTokenRequestBody, request.correlationId);
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, request.embeddedClientId || request.tokenBodyParameters?.[CLIENT_ID] || this.config.authOptions.clientId);
			if (request.redirectUri) addRedirectUri(parameters, request.redirectUri);
			addScopes(parameters, request.scopes, true, this.config.authOptions.authority.options.OIDCOptions?.defaultScopes);
			addGrantType(parameters, GrantType.REFRESH_TOKEN_GRANT);
			addClientInfo(parameters);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager && !isOidcProtocolMode(this.config)) addServerTelemetry(parameters, this.serverTelemetryManager);
			addRefreshToken(parameters, request.refreshToken);
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			if (this.config.clientCredentials.clientAssertion) {
				const clientAssertion = this.config.clientCredentials.clientAssertion;
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			if (request.authenticationScheme === AuthenticationScheme.POP) {
				const popTokenGenerator = new PopTokenGenerator(this.cryptoUtils, this.performanceClient);
				let reqCnfData;
				if (!request.popKid) reqCnfData = (await invokeAsync(popTokenGenerator.generateCnf.bind(popTokenGenerator), PerformanceEvents.PopTokenGenerateCnf, this.logger, this.performanceClient, request.correlationId)(request, this.logger)).reqCnfString;
				else reqCnfData = this.cryptoUtils.encodeKid(request.popKid);
				addPopToken(parameters, reqCnfData);
			} else if (request.authenticationScheme === AuthenticationScheme.SSH) if (request.sshJwk) addSshJwk(parameters, request.sshJwk);
			else throw createClientConfigurationError(missingSshJwk);
			if (this.config.systemOptions.preventCorsPreflight && request.ccsCredential) switch (request.ccsCredential.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.ccsCredential.credential));
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					addCcsUpn(parameters, request.ccsCredential.credential);
					break;
			}
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenBodyParameters) addExtraQueryParameters(parameters, request.tokenBodyParameters);
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : this.config.authOptions.clientCapabilities;
			if (!StringUtils.isEmptyObj(request.claims) || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
			return mapToQueryString(parameters);
		}
	};
	/** @internal */
	var SilentFlowClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
		}
		/**
		* Retrieves token from cache or throws an error if it must be refreshed.
		* @param request
		*/
		async acquireCachedToken(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.SilentFlowClientAcquireCachedToken, request.correlationId);
			let lastCacheOutcome = CacheOutcome.NOT_APPLICABLE;
			if (request.forceRefresh || !this.config.cacheOptions.claimsBasedCachingEnabled && !StringUtils.isEmptyObj(request.claims)) {
				this.setCacheOutcome(CacheOutcome.FORCE_REFRESH_OR_CLAIMS, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			}
			if (!request.account) throw createClientAuthError(noAccountInSilentRequest);
			const requestTenantId = request.account.tenantId || getTenantFromAuthorityString(request.authority);
			const tokenKeys = this.cacheManager.getTokenKeys();
			const cachedAccessToken = this.cacheManager.getAccessToken(request.account, request, tokenKeys, requestTenantId);
			if (!cachedAccessToken) {
				this.setCacheOutcome(CacheOutcome.NO_CACHED_ACCESS_TOKEN, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			} else if (wasClockTurnedBack(cachedAccessToken.cachedAt) || isTokenExpired(cachedAccessToken.expiresOn, this.config.systemOptions.tokenRenewalOffsetSeconds)) {
				this.setCacheOutcome(CacheOutcome.CACHED_ACCESS_TOKEN_EXPIRED, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			} else if (cachedAccessToken.refreshOn && isTokenExpired(cachedAccessToken.refreshOn, 0)) lastCacheOutcome = CacheOutcome.PROACTIVELY_REFRESHED;
			const environment = request.authority || this.authority.getPreferredCache();
			const cacheRecord = {
				account: this.cacheManager.getAccount(this.cacheManager.generateAccountKey(request.account), request.correlationId),
				accessToken: cachedAccessToken,
				idToken: this.cacheManager.getIdToken(request.account, request.correlationId, tokenKeys, requestTenantId, this.performanceClient),
				refreshToken: null,
				appMetadata: this.cacheManager.readAppMetadataFromCache(environment)
			};
			this.setCacheOutcome(lastCacheOutcome, request.correlationId);
			if (this.config.serverTelemetryManager) this.config.serverTelemetryManager.incrementCacheHits();
			return [await invokeAsync(this.generateResultFromCacheRecord.bind(this), PerformanceEvents.SilentFlowClientGenerateResultFromCacheRecord, this.logger, this.performanceClient, request.correlationId)(cacheRecord, request), lastCacheOutcome];
		}
		setCacheOutcome(cacheOutcome, correlationId) {
			this.serverTelemetryManager?.setCacheOutcome(cacheOutcome);
			this.performanceClient?.addFields({ cacheOutcome }, correlationId);
			if (cacheOutcome !== CacheOutcome.NOT_APPLICABLE) this.logger.info(`Token refresh is required due to cache outcome: ${cacheOutcome}`);
		}
		/**
		* Helper function to build response object from the CacheRecord
		* @param cacheRecord
		*/
		async generateResultFromCacheRecord(cacheRecord, request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.SilentFlowClientGenerateResultFromCacheRecord, request.correlationId);
			let idTokenClaims;
			if (cacheRecord.idToken) idTokenClaims = extractTokenClaims(cacheRecord.idToken.secret, this.config.cryptoInterface.base64Decode);
			if (request.maxAge || request.maxAge === 0) {
				const authTime = idTokenClaims?.auth_time;
				if (!authTime) throw createClientAuthError(authTimeNotFound);
				checkMaxAge(authTime, request.maxAge);
			}
			return ResponseHandler.generateAuthenticationResult(this.cryptoUtils, this.authority, cacheRecord, true, request, idTokenClaims);
		}
	};
	const StubbedNetworkModule = {
		sendGetRequestAsync: () => {
			return Promise.reject(createClientAuthError(methodNotImplemented));
		},
		sendPostRequestAsync: () => {
			return Promise.reject(createClientAuthError(methodNotImplemented));
		}
	};
	/**
	* Returns map of parameters that are applicable to all calls to /authorize whether using PKCE or EAR
	* @param config
	* @param request
	* @param logger
	* @param performanceClient
	* @returns
	*/
	function getStandardAuthorizeRequestParameters(authOptions, request, logger, performanceClient) {
		const correlationId = request.correlationId;
		const parameters = /* @__PURE__ */ new Map();
		addClientId(parameters, request.embeddedClientId || request.extraQueryParameters?.[CLIENT_ID] || authOptions.clientId);
		addScopes(parameters, [...request.scopes || [], ...request.extraScopesToConsent || []], true, authOptions.authority.options.OIDCOptions?.defaultScopes);
		addRedirectUri(parameters, request.redirectUri);
		addCorrelationId(parameters, correlationId);
		addResponseMode(parameters, request.responseMode);
		addClientInfo(parameters);
		addCliData(parameters);
		if (request.prompt) {
			addPrompt(parameters, request.prompt);
			performanceClient?.addFields({ prompt: request.prompt }, correlationId);
		}
		if (request.domainHint) {
			addDomainHint(parameters, request.domainHint);
			performanceClient?.addFields({ domainHintFromRequest: true }, correlationId);
		}
		if (request.prompt !== PromptValue.SELECT_ACCOUNT) {
			if (request.sid && request.prompt === PromptValue.NONE) {
				logger.verbose("createAuthCodeUrlQueryString: Prompt is none, adding sid from request");
				addSid(parameters, request.sid);
				performanceClient?.addFields({ sidFromRequest: true }, correlationId);
			} else if (request.account) {
				const accountSid = extractAccountSid(request.account);
				let accountLoginHintClaim = extractLoginHint(request.account);
				if (accountLoginHintClaim && request.domainHint) {
					logger.warning(`AuthorizationCodeClient.createAuthCodeUrlQueryString: "domainHint" param is set, skipping opaque "login_hint" claim. Please consider not passing domainHint`);
					accountLoginHintClaim = null;
				}
				if (accountLoginHintClaim) {
					logger.verbose("createAuthCodeUrlQueryString: login_hint claim present on account");
					addLoginHint(parameters, accountLoginHintClaim);
					performanceClient?.addFields({ loginHintFromClaim: true }, correlationId);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				} else if (accountSid && request.prompt === PromptValue.NONE) {
					logger.verbose("createAuthCodeUrlQueryString: Prompt is none, adding sid from account");
					addSid(parameters, accountSid);
					performanceClient?.addFields({ sidFromClaim: true }, correlationId);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				} else if (request.loginHint) {
					logger.verbose("createAuthCodeUrlQueryString: Adding login_hint from request");
					addLoginHint(parameters, request.loginHint);
					addCcsUpn(parameters, request.loginHint);
					performanceClient?.addFields({ loginHintFromRequest: true }, correlationId);
				} else if (request.account.username) {
					logger.verbose("createAuthCodeUrlQueryString: Adding login_hint from account");
					addLoginHint(parameters, request.account.username);
					performanceClient?.addFields({ loginHintFromUpn: true }, correlationId);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				}
			} else if (request.loginHint) {
				logger.verbose("createAuthCodeUrlQueryString: No account, adding login_hint from request");
				addLoginHint(parameters, request.loginHint);
				addCcsUpn(parameters, request.loginHint);
				performanceClient?.addFields({ loginHintFromRequest: true }, correlationId);
			}
		} else logger.verbose("createAuthCodeUrlQueryString: Prompt is select_account, ignoring account hints");
		if (request.nonce) addNonce(parameters, request.nonce);
		if (request.state) addState(parameters, request.state);
		if (request.embeddedClientId) addBrokerParameters(parameters, authOptions.clientId, authOptions.redirectUri);
		const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : authOptions.clientCapabilities;
		if (request.claims || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
		if (authOptions.instanceAware && (!request.extraQueryParameters || !Object.keys(request.extraQueryParameters).includes(INSTANCE_AWARE))) addInstanceAware(parameters);
		return parameters;
	}
	/**
	* Returns authorize endpoint with given request parameters in the query string
	* @param authority
	* @param requestParameters
	* @returns
	*/
	function getAuthorizeUrl(authority, requestParameters, encodeParams, extraQueryParameters) {
		const queryString = mapToQueryString(requestParameters, encodeParams, extraQueryParameters);
		return UrlString.appendQueryString(authority.authorizationEndpoint, queryString);
	}
	/**
	* Handles the hash fragment response from public client code request. Returns a code response used by
	* the client to exchange for a token in acquireToken.
	* @param serverParams
	* @param cachedState
	*/
	function getAuthorizationCodePayload(serverParams, cachedState) {
		validateAuthorizationResponse(serverParams, cachedState);
		if (!serverParams.code) throw createClientAuthError(authorizationCodeMissingFromServerResponse);
		return serverParams;
	}
	/**
	* Function which validates server authorization code response.
	* @param serverResponseHash
	* @param requestState
	*/
	function validateAuthorizationResponse(serverResponse, requestState) {
		if (!serverResponse.state || !requestState) throw serverResponse.state ? createClientAuthError(stateNotFound, "Cached State") : createClientAuthError(stateNotFound, "Server State");
		let decodedServerResponseState;
		let decodedRequestState;
		try {
			decodedServerResponseState = decodeURIComponent(serverResponse.state);
		} catch (e) {
			throw createClientAuthError(invalidState, serverResponse.state);
		}
		try {
			decodedRequestState = decodeURIComponent(requestState);
		} catch (e) {
			throw createClientAuthError(invalidState, serverResponse.state);
		}
		if (decodedServerResponseState !== decodedRequestState) throw createClientAuthError(stateMismatch);
		if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
			const serverErrorNo = parseServerErrorNo(serverResponse);
			if (isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) throw new InteractionRequiredAuthError(serverResponse.error || "", serverResponse.error_description, serverResponse.suberror, serverResponse.timestamp || "", serverResponse.trace_id || "", serverResponse.correlation_id || "", serverResponse.claims || "", serverErrorNo);
			throw new ServerError(serverResponse.error || "", serverResponse.error_description, serverResponse.suberror, serverErrorNo);
		}
	}
	/**
	* Get server error No from the error_uri
	* @param serverResponse
	* @returns
	*/
	function parseServerErrorNo(serverResponse) {
		const errorCodePrefixIndex = serverResponse.error_uri?.lastIndexOf("code=");
		return errorCodePrefixIndex && errorCodePrefixIndex >= 0 ? serverResponse.error_uri?.substring(errorCodePrefixIndex + 5) : void 0;
	}
	/**
	* Helper to get sid from account. Returns null if idTokenClaims are not present or sid is not present.
	* @param account
	*/
	function extractAccountSid(account) {
		return account.idTokenClaims?.sid || null;
	}
	function extractLoginHint(account) {
		return account.loginHint || account.idTokenClaims?.login_hint || null;
	}
	var Authorize = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		getAuthorizationCodePayload,
		getAuthorizeUrl,
		getStandardAuthorizeRequestParameters,
		validateAuthorizationResponse
	});
	/**
	* This is a helper class that parses supported HTTP response authentication headers to extract and return
	* header challenge values that can be used outside the basic authorization flows.
	*/
	var AuthenticationHeaderParser = class {
		constructor(headers) {
			this.headers = headers;
		}
		/**
		* This method parses the SHR nonce value out of either the Authentication-Info or WWW-Authenticate authentication headers.
		* @returns
		*/
		getShrNonce() {
			const authenticationInfo = this.headers[HeaderNames.AuthenticationInfo];
			if (authenticationInfo) {
				const authenticationInfoChallenges = this.parseChallenges(authenticationInfo);
				if (authenticationInfoChallenges.nextnonce) return authenticationInfoChallenges.nextnonce;
				throw createClientConfigurationError(invalidAuthenticationHeader);
			}
			const wwwAuthenticate = this.headers[HeaderNames.WWWAuthenticate];
			if (wwwAuthenticate) {
				const wwwAuthenticateChallenges = this.parseChallenges(wwwAuthenticate);
				if (wwwAuthenticateChallenges.nonce) return wwwAuthenticateChallenges.nonce;
				throw createClientConfigurationError(invalidAuthenticationHeader);
			}
			throw createClientConfigurationError(missingNonceAuthenticationHeader);
		}
		/**
		* Parses an HTTP header's challenge set into a key/value map.
		* @param header
		* @returns
		*/
		parseChallenges(header) {
			const schemeSeparator = header.indexOf(" ");
			const challenges = header.substr(schemeSeparator + 1).split(",");
			const challengeMap = {};
			challenges.forEach((challenge) => {
				const [key, value] = challenge.split("=");
				challengeMap[key] = unescape(value.replace(/['"]+/g, Constants.EMPTY_STRING));
			});
			return challengeMap;
		}
	};
	/**
	* Converts a numeric tag to a string representation
	* @param tag - The numeric tag to convert
	* @returns The string representation of the tag
	*/
	function tagToString(tag) {
		if (tag === 0) return "UNTAG";
		const tagSymbolSpace = "abcdefghijklmnopqrstuvwxyz0123456789****************************";
		let tagBuffer = "*****";
		tagBuffer = [
			tagSymbolSpace[tag >> 24 & 63],
			tagSymbolSpace[tag >> 18 & 63],
			tagSymbolSpace[tag >> 12 & 63],
			tagSymbolSpace[tag >> 6 & 63],
			tagSymbolSpace[tag >> 0 & 63]
		].join("");
		return tagBuffer;
	}
	/**
	* Error class for MSAL Runtime errors that preserves detailed broker information
	*/
	var PlatformBrokerError = class PlatformBrokerError extends AuthError {
		constructor(errorStatus, errorContext, errorCode, errorTag) {
			const tagString = tagToString(errorTag);
			const enhancedErrorContext = errorContext ? `${errorContext} (Error Code: ${errorCode}, Tag: ${tagString})` : `(Error Code: ${errorCode}, Tag: ${tagString})`;
			super(errorStatus, enhancedErrorContext);
			this.name = "PlatformBrokerError";
			this.statusCode = errorCode;
			this.tag = tagString;
			Object.setPrototypeOf(this, PlatformBrokerError.prototype);
		}
	};
	const skuGroupSeparator = ",";
	const skuValueSeparator = "|";
	function makeExtraSkuString(params) {
		const { skus, libraryName, libraryVersion, extensionName, extensionVersion } = params;
		const skuMap = new Map([[0, [libraryName, libraryVersion]], [2, [extensionName, extensionVersion]]]);
		let skuArr = [];
		if (skus?.length) {
			skuArr = skus.split(skuGroupSeparator);
			if (skuArr.length < 4) return skus;
		} else skuArr = Array.from({ length: 4 }, () => skuValueSeparator);
		skuMap.forEach((value, key) => {
			if (value.length === 2 && value[0]?.length && value[1]?.length) setSku({
				skuArr,
				index: key,
				skuName: value[0],
				skuVersion: value[1]
			});
		});
		return skuArr.join(skuGroupSeparator);
	}
	function setSku(params) {
		const { skuArr, index, skuName, skuVersion } = params;
		if (index >= skuArr.length) return;
		skuArr[index] = [skuName, skuVersion].join(skuValueSeparator);
	}
	/** @internal */
	var ServerTelemetryManager = class ServerTelemetryManager {
		constructor(telemetryRequest, cacheManager) {
			this.cacheOutcome = CacheOutcome.NOT_APPLICABLE;
			this.cacheManager = cacheManager;
			this.apiId = telemetryRequest.apiId;
			this.correlationId = telemetryRequest.correlationId;
			this.wrapperSKU = telemetryRequest.wrapperSKU || Constants.EMPTY_STRING;
			this.wrapperVer = telemetryRequest.wrapperVer || Constants.EMPTY_STRING;
			this.telemetryCacheKey = SERVER_TELEM_CONSTANTS.CACHE_KEY + Separators.CACHE_KEY_SEPARATOR + telemetryRequest.clientId;
		}
		/**
		* API to add MSER Telemetry to request
		*/
		generateCurrentRequestHeaderValue() {
			const request = `${this.apiId}${SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR}${this.cacheOutcome}`;
			const platformFieldsArr = [this.wrapperSKU, this.wrapperVer];
			const nativeBrokerErrorCode = this.getNativeBrokerErrorCode();
			if (nativeBrokerErrorCode?.length) platformFieldsArr.push(`broker_error=${nativeBrokerErrorCode}`);
			const platformFields = platformFieldsArr.join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const requestWithRegionDiscoveryFields = [request, this.getRegionDiscoveryFields()].join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			return [
				SERVER_TELEM_CONSTANTS.SCHEMA_VERSION,
				requestWithRegionDiscoveryFields,
				platformFields
			].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
		}
		/**
		* API to add MSER Telemetry for the last failed request
		*/
		generateLastRequestHeaderValue() {
			const lastRequests = this.getLastRequests();
			const maxErrors = ServerTelemetryManager.maxErrorsToSend(lastRequests);
			const failedRequests = lastRequests.failedRequests.slice(0, 2 * maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const errors = lastRequests.errors.slice(0, maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const errorCount = lastRequests.errors.length;
			const platformFields = [errorCount, maxErrors < errorCount ? SERVER_TELEM_CONSTANTS.OVERFLOW_TRUE : SERVER_TELEM_CONSTANTS.OVERFLOW_FALSE].join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			return [
				SERVER_TELEM_CONSTANTS.SCHEMA_VERSION,
				lastRequests.cacheHits,
				failedRequests,
				errors,
				platformFields
			].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
		}
		/**
		* API to cache token failures for MSER data capture
		* @param error
		*/
		cacheFailedRequest(error) {
			const lastRequests = this.getLastRequests();
			if (lastRequests.errors.length >= SERVER_TELEM_CONSTANTS.MAX_CACHED_ERRORS) {
				lastRequests.failedRequests.shift();
				lastRequests.failedRequests.shift();
				lastRequests.errors.shift();
			}
			lastRequests.failedRequests.push(this.apiId, this.correlationId);
			if (error instanceof Error && !!error && error.toString()) if (error instanceof AuthError) if (error.subError) lastRequests.errors.push(error.subError);
			else if (error.errorCode) lastRequests.errors.push(error.errorCode);
			else lastRequests.errors.push(error.toString());
			else lastRequests.errors.push(error.toString());
			else lastRequests.errors.push(SERVER_TELEM_CONSTANTS.UNKNOWN_ERROR);
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		/**
		* Update server telemetry cache entry by incrementing cache hit counter
		*/
		incrementCacheHits() {
			const lastRequests = this.getLastRequests();
			lastRequests.cacheHits += 1;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
			return lastRequests.cacheHits;
		}
		/**
		* Get the server telemetry entity from cache or initialize a new one
		*/
		getLastRequests() {
			return this.cacheManager.getServerTelemetry(this.telemetryCacheKey) || {
				failedRequests: [],
				errors: [],
				cacheHits: 0
			};
		}
		/**
		* Remove server telemetry cache entry
		*/
		clearTelemetryCache() {
			const lastRequests = this.getLastRequests();
			const numErrorsFlushed = ServerTelemetryManager.maxErrorsToSend(lastRequests);
			if (numErrorsFlushed === lastRequests.errors.length) this.cacheManager.removeItem(this.telemetryCacheKey, this.correlationId);
			else {
				const serverTelemEntity = {
					failedRequests: lastRequests.failedRequests.slice(numErrorsFlushed * 2),
					errors: lastRequests.errors.slice(numErrorsFlushed),
					cacheHits: 0
				};
				this.cacheManager.setServerTelemetry(this.telemetryCacheKey, serverTelemEntity, this.correlationId);
			}
		}
		/**
		* Returns the maximum number of errors that can be flushed to the server in the next network request
		* @param serverTelemetryEntity
		*/
		static maxErrorsToSend(serverTelemetryEntity) {
			let i;
			let maxErrors = 0;
			let dataSize = 0;
			const errorCount = serverTelemetryEntity.errors.length;
			for (i = 0; i < errorCount; i++) {
				const apiId = serverTelemetryEntity.failedRequests[2 * i] || Constants.EMPTY_STRING;
				const correlationId = serverTelemetryEntity.failedRequests[2 * i + 1] || Constants.EMPTY_STRING;
				const errorCode = serverTelemetryEntity.errors[i] || Constants.EMPTY_STRING;
				dataSize += apiId.toString().length + correlationId.toString().length + errorCode.length + 3;
				if (dataSize < SERVER_TELEM_CONSTANTS.MAX_LAST_HEADER_BYTES) maxErrors += 1;
				else break;
			}
			return maxErrors;
		}
		/**
		* Get the region discovery fields
		*
		* @returns string
		*/
		getRegionDiscoveryFields() {
			const regionDiscoveryFields = [];
			regionDiscoveryFields.push(this.regionUsed || Constants.EMPTY_STRING);
			regionDiscoveryFields.push(this.regionSource || Constants.EMPTY_STRING);
			regionDiscoveryFields.push(this.regionOutcome || Constants.EMPTY_STRING);
			return regionDiscoveryFields.join(",");
		}
		/**
		* Update the region discovery metadata
		*
		* @param regionDiscoveryMetadata
		* @returns void
		*/
		updateRegionDiscoveryMetadata(regionDiscoveryMetadata) {
			this.regionUsed = regionDiscoveryMetadata.region_used;
			this.regionSource = regionDiscoveryMetadata.region_source;
			this.regionOutcome = regionDiscoveryMetadata.region_outcome;
		}
		/**
		* Set cache outcome
		*/
		setCacheOutcome(cacheOutcome) {
			this.cacheOutcome = cacheOutcome;
		}
		setNativeBrokerErrorCode(errorCode) {
			const lastRequests = this.getLastRequests();
			lastRequests.nativeBrokerErrorCode = errorCode;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		getNativeBrokerErrorCode() {
			return this.getLastRequests().nativeBrokerErrorCode;
		}
		clearNativeBrokerErrorCode() {
			const lastRequests = this.getLastRequests();
			delete lastRequests.nativeBrokerErrorCode;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		static makeExtraSkuString(params) {
			return makeExtraSkuString(params);
		}
	};
	exports.AADAuthorityConstants = AADAuthorityConstants;
	exports.AADServerParamKeys = AADServerParamKeys;
	exports.AccountEntity = AccountEntity;
	exports.AuthError = AuthError;
	exports.AuthErrorCodes = AuthErrorCodes;
	exports.AuthErrorMessage = AuthErrorMessage;
	exports.AuthToken = AuthToken;
	exports.AuthenticationHeaderParser = AuthenticationHeaderParser;
	exports.AuthenticationScheme = AuthenticationScheme;
	exports.Authority = Authority;
	exports.AuthorityFactory = AuthorityFactory;
	exports.AuthorityType = AuthorityType;
	exports.AuthorizationCodeClient = AuthorizationCodeClient;
	exports.Authorize = Authorize;
	exports.AzureCloudInstance = AzureCloudInstance;
	exports.BaseClient = BaseClient;
	exports.CacheAccountType = CacheAccountType;
	exports.CacheError = CacheError;
	exports.CacheErrorCodes = CacheErrorCodes;
	exports.CacheHelpers = CacheHelpers;
	exports.CacheManager = CacheManager;
	exports.CacheOutcome = CacheOutcome;
	exports.CacheType = CacheType;
	exports.CcsCredentialType = CcsCredentialType;
	exports.ClaimsRequestKeys = ClaimsRequestKeys;
	exports.ClientAssertionUtils = ClientAssertionUtils;
	exports.ClientAuthError = ClientAuthError;
	exports.ClientAuthErrorCodes = ClientAuthErrorCodes;
	exports.ClientAuthErrorMessage = ClientAuthErrorMessage;
	exports.ClientConfigurationError = ClientConfigurationError;
	exports.ClientConfigurationErrorCodes = ClientConfigurationErrorCodes;
	exports.ClientConfigurationErrorMessage = ClientConfigurationErrorMessage;
	exports.CodeChallengeMethodValues = CodeChallengeMethodValues;
	exports.Constants = Constants;
	exports.CredentialType = CredentialType;
	exports.DEFAULT_CRYPTO_IMPLEMENTATION = DEFAULT_CRYPTO_IMPLEMENTATION;
	exports.DEFAULT_SYSTEM_OPTIONS = DEFAULT_SYSTEM_OPTIONS;
	exports.DEFAULT_TOKEN_RENEWAL_OFFSET_SEC = DEFAULT_TOKEN_RENEWAL_OFFSET_SEC;
	exports.DefaultStorageClass = DefaultStorageClass;
	exports.EncodingTypes = EncodingTypes;
	exports.Errors = Errors;
	exports.GrantType = GrantType;
	exports.HeaderNames = HeaderNames;
	exports.HttpMethod = HttpMethod;
	exports.HttpStatus = HttpStatus;
	exports.IntFields = IntFields;
	exports.InteractionRequiredAuthError = InteractionRequiredAuthError;
	exports.InteractionRequiredAuthErrorCodes = InteractionRequiredAuthErrorCodes;
	exports.InteractionRequiredAuthErrorMessage = InteractionRequiredAuthErrorMessage;
	exports.JsonWebTokenTypes = JsonWebTokenTypes;
	exports.Logger = Logger;
	exports.NetworkError = NetworkError;
	exports.OAuthResponseType = OAuthResponseType;
	exports.OIDC_DEFAULT_SCOPES = OIDC_DEFAULT_SCOPES;
	exports.ONE_DAY_IN_MS = ONE_DAY_IN_MS;
	exports.PasswordGrantConstants = PasswordGrantConstants;
	exports.PerformanceEventAbbreviations = PerformanceEventAbbreviations;
	exports.PerformanceEventStatus = PerformanceEventStatus;
	exports.PerformanceEvents = PerformanceEvents;
	exports.PersistentCacheKeys = PersistentCacheKeys;
	exports.PlatformBrokerError = PlatformBrokerError;
	exports.PopTokenGenerator = PopTokenGenerator;
	exports.PromptValue = PromptValue;
	exports.ProtocolMode = ProtocolMode;
	exports.ProtocolUtils = ProtocolUtils;
	exports.RefreshTokenClient = RefreshTokenClient;
	exports.RequestParameterBuilder = RequestParameterBuilder;
	exports.ResponseHandler = ResponseHandler;
	exports.ResponseMode = ResponseMode;
	exports.ScopeSet = ScopeSet;
	exports.ServerError = ServerError;
	exports.ServerResponseType = ServerResponseType;
	exports.ServerTelemetryManager = ServerTelemetryManager;
	exports.SilentFlowClient = SilentFlowClient;
	exports.StringUtils = StringUtils;
	exports.StubPerformanceClient = StubPerformanceClient;
	exports.StubPerformanceMeasurement = StubPerformanceMeasurement;
	exports.StubbedNetworkModule = StubbedNetworkModule;
	exports.THE_FAMILY_ID = THE_FAMILY_ID;
	exports.ThrottlingConstants = ThrottlingConstants;
	exports.ThrottlingUtils = ThrottlingUtils;
	exports.TimeUtils = TimeUtils;
	exports.TokenCacheContext = TokenCacheContext;
	exports.UrlString = UrlString;
	exports.UrlUtils = UrlUtils;
	exports.buildAccountToCache = buildAccountToCache;
	exports.buildClientInfo = buildClientInfo;
	exports.buildClientInfoFromHomeAccountId = buildClientInfoFromHomeAccountId;
	exports.buildStaticAuthorityOptions = buildStaticAuthorityOptions;
	exports.buildTenantProfile = buildTenantProfile;
	exports.createAuthError = createAuthError;
	exports.createCacheError = createCacheError;
	exports.createClientAuthError = createClientAuthError;
	exports.createClientConfigurationError = createClientConfigurationError;
	exports.createInteractionRequiredAuthError = createInteractionRequiredAuthError;
	exports.createNetworkError = createNetworkError;
	exports.formatAuthorityUri = formatAuthorityUri;
	exports.getClientAssertion = getClientAssertion;
	exports.getRequestThumbprint = getRequestThumbprint;
	exports.getTenantIdFromIdTokenClaims = getTenantIdFromIdTokenClaims;
	exports.invoke = invoke;
	exports.invokeAsync = invokeAsync;
	exports.tenantIdMatchesHomeTenant = tenantIdMatchesHomeTenant;
	exports.updateAccountTenantProfileData = updateAccountTenantProfileData;
	exports.version = version;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/node_modules/@azure/msal-common/lib/index-browser.cjs
/*! @azure/msal-common v15.17.0 2026-03-18 */
var require_index_browser = /* @__PURE__ */ __commonJSMin(((exports) => {
	var indexNode = require_index_node_Ddjhj5ij();
	const missingKidError = "missing_kid_error";
	const missingAlgError = "missing_alg_error";
	const JoseHeaderErrorMessages = {
		[missingKidError]: "The JOSE Header for the requested JWT, JWS or JWK object requires a keyId to be configured as the 'kid' header claim. No 'kid' value was provided.",
		[missingAlgError]: "The JOSE Header for the requested JWT, JWS or JWK object requires an algorithm to be specified as the 'alg' header claim. No 'alg' value was provided."
	};
	/**
	* Error thrown when there is an error in the client code running on the browser.
	*/
	var JoseHeaderError = class JoseHeaderError extends indexNode.AuthError {
		constructor(errorCode, errorMessage) {
			super(errorCode, errorMessage);
			this.name = "JoseHeaderError";
			Object.setPrototypeOf(this, JoseHeaderError.prototype);
		}
	};
	/** Returns JoseHeaderError object */
	function createJoseHeaderError(code) {
		return new JoseHeaderError(code, JoseHeaderErrorMessages[code]);
	}
	/** @internal */
	var JoseHeader = class JoseHeader {
		constructor(options) {
			this.typ = options.typ;
			this.alg = options.alg;
			this.kid = options.kid;
		}
		/**
		* Builds SignedHttpRequest formatted JOSE Header from the
		* JOSE Header options provided or previously set on the object and returns
		* the stringified header object.
		* Throws if keyId or algorithm aren't provided since they are required for Access Token Binding.
		* @param shrHeaderOptions
		* @returns
		*/
		static getShrHeaderString(shrHeaderOptions) {
			if (!shrHeaderOptions.kid) throw createJoseHeaderError(missingKidError);
			if (!shrHeaderOptions.alg) throw createJoseHeaderError(missingAlgError);
			const shrHeader = new JoseHeader({
				typ: shrHeaderOptions.typ || indexNode.JsonWebTokenTypes.Pop,
				kid: shrHeaderOptions.kid,
				alg: shrHeaderOptions.alg
			});
			return JSON.stringify(shrHeader);
		}
	};
	/**
	* Starts context by adding payload to the stack
	* @param event {PerformanceEvent}
	* @param abbreviations {Map<string, string>} event name abbreviations
	* @param stack {?PerformanceEventStackedContext[]} stack
	*/
	function startContext(event, abbreviations, stack) {
		if (!stack) return;
		stack.push({ name: abbreviations.get(event.name) || event.name });
	}
	/**
	* Ends context by removing payload from the stack and returning parent or self, if stack is empty, payload
	*
	* @param event {PerformanceEvent}
	* @param abbreviations {Map<string, string>} event name abbreviations
	* @param stack {?PerformanceEventStackedContext[]} stack
	* @param error {?unknown} error
	*/
	function endContext(event, abbreviations, stack, error) {
		if (!stack?.length) return;
		const peek = (stack) => {
			return stack.length ? stack[stack.length - 1] : void 0;
		};
		const abbrEventName = abbreviations.get(event.name) || event.name;
		if (peek(stack)?.name !== abbrEventName) return;
		const current = stack?.pop();
		if (!current) return;
		const errorCode = error instanceof indexNode.AuthError ? error.errorCode : error instanceof Error ? error.name : void 0;
		const subErr = error instanceof indexNode.AuthError ? error.subError : void 0;
		if (errorCode && current.childErr !== errorCode) {
			current.err = errorCode;
			if (subErr) current.subErr = subErr;
		}
		delete current.name;
		delete current.childErr;
		const context = {
			...current,
			dur: event.durationMs
		};
		if (!event.success) context.fail = 1;
		const parent = peek(stack);
		if (!parent) return { [abbrEventName]: context };
		if (errorCode) parent.childErr = errorCode;
		let childName;
		if (!parent[abbrEventName]) childName = abbrEventName;
		else childName = `${abbrEventName}_${Object.keys(parent).filter((key) => key.startsWith(abbrEventName)).length + 1}`;
		parent[childName] = context;
		return parent;
	}
	/**
	* Adds error name and stack trace to the telemetry event
	* @param error {Error}
	* @param logger {Logger}
	* @param event {PerformanceEvent}
	* @param stackMaxSize {number} max error stack size to capture
	*/
	function addError(error, logger, event, stackMaxSize = 5) {
		if (!(error instanceof Error)) {
			logger.trace("PerformanceClient.addErrorStack: Input error is not instance of Error", event.correlationId);
			return;
		} else if (error instanceof indexNode.AuthError) {
			event.errorCode = error.errorCode;
			event.subErrorCode = error.subError;
			if (!event.serverErrorNo && (error instanceof indexNode.ServerError || error instanceof indexNode.InteractionRequiredAuthError) && error.errorNo) event.serverErrorNo = error.errorNo;
			return;
		} else if (error instanceof indexNode.CacheError) {
			event.errorCode = error.errorCode;
			return;
		} else if (event.errorStack?.length) {
			logger.trace("PerformanceClient.addErrorStack: Stack already exist", event.correlationId);
			return;
		} else if (!error.stack?.length) {
			logger.trace("PerformanceClient.addErrorStack: Input stack is empty", event.correlationId);
			return;
		}
		if (error.stack) event.errorStack = compactStack(error.stack, stackMaxSize);
		event.errorName = error.name;
	}
	/**
	* Compacts error stack into array by fetching N first entries
	* @param stack {string} error stack
	* @param stackMaxSize {number} max error stack size to capture
	* @returns {string[]}
	*/
	function compactStack(stack, stackMaxSize) {
		if (stackMaxSize < 0) return [];
		const stackArr = stack.split("\n") || [];
		const res = [];
		const firstLine = stackArr[0];
		if (firstLine.startsWith("TypeError: Cannot read property") || firstLine.startsWith("TypeError: Cannot read properties of") || firstLine.startsWith("TypeError: Cannot set property") || firstLine.startsWith("TypeError: Cannot set properties of") || firstLine.endsWith("is not a function")) res.push(compactStackLine(firstLine));
		else if (firstLine.startsWith("SyntaxError") || firstLine.startsWith("TypeError")) res.push(compactStackLine(firstLine.replace(/['].*[']|["].*["]/g, "<redacted>")));
		for (let ix = 1; ix < stackArr.length; ix++) {
			if (res.length >= stackMaxSize) break;
			const line = stackArr[ix];
			res.push(compactStackLine(line));
		}
		return res;
	}
	/**
	* Compacts error stack line by shortening file path
	* Example: https://localhost/msal-common/src/authority/Authority.js:100:1 -> Authority.js:100:1
	* @param line {string} stack line
	* @returns {string}
	*/
	function compactStackLine(line) {
		const filePathIx = line.lastIndexOf(" ") + 1;
		if (filePathIx < 1) return line;
		const filePath = line.substring(filePathIx);
		let fileNameIx = filePath.lastIndexOf("/");
		fileNameIx = fileNameIx < 0 ? filePath.lastIndexOf("\\") : fileNameIx;
		if (fileNameIx >= 0) return (line.substring(0, filePathIx) + "(" + filePath.substring(fileNameIx + 1) + (filePath.charAt(filePath.length - 1) === ")" ? "" : ")")).trimStart();
		return line.trimStart();
	}
	function getAccountType(account) {
		const idTokenClaims = account?.idTokenClaims;
		if (idTokenClaims?.tfp || idTokenClaims?.acr) return "B2C";
		if (!idTokenClaims?.tid) return;
		else if (idTokenClaims?.tid === "9188040d-6c67-4c5b-b112-36a304b66dad") return "MSA";
		return "AAD";
	}
	var PerformanceClient = class {
		/**
		* Creates an instance of PerformanceClient,
		* an abstract class containing core performance telemetry logic.
		*
		* @constructor
		* @param {string} clientId Client ID of the application
		* @param {string} authority Authority used by the application
		* @param {Logger} logger Logger used by the application
		* @param {string} libraryName Name of the library
		* @param {string} libraryVersion Version of the library
		* @param {ApplicationTelemetry} applicationTelemetry application name and version
		* @param {Set<String>} intFields integer fields to be truncated
		* @param {Map<string, string>} abbreviations event name abbreviations
		*/
		constructor(clientId, authority, logger, libraryName, libraryVersion, applicationTelemetry, intFields, abbreviations) {
			this.authority = authority;
			this.libraryName = libraryName;
			this.libraryVersion = libraryVersion;
			this.applicationTelemetry = applicationTelemetry;
			this.clientId = clientId;
			this.logger = logger;
			this.callbacks = /* @__PURE__ */ new Map();
			this.eventsByCorrelationId = /* @__PURE__ */ new Map();
			this.eventStack = /* @__PURE__ */ new Map();
			this.queueMeasurements = /* @__PURE__ */ new Map();
			this.preQueueTimeByCorrelationId = /* @__PURE__ */ new Map();
			this.intFields = intFields || /* @__PURE__ */ new Set();
			for (const item of indexNode.IntFields) this.intFields.add(item);
			this.abbreviations = abbreviations || /* @__PURE__ */ new Map();
			for (const [key, value] of indexNode.PerformanceEventAbbreviations) this.abbreviations.set(key, value);
		}
		/**
		* Starts and returns an platform-specific implementation of IPerformanceMeasurement.
		* Note: this function can be changed to abstract at the next major version bump.
		*
		* @param {string} measureName
		* @param {string} correlationId
		* @returns {IPerformanceMeasurement}
		* @deprecated This method will be removed in the next major version
		*/
		startPerformanceMeasurement(measureName, correlationId) {
			return {};
		}
		/**
		* Gets map of pre-queue times by correlation Id
		*
		* @param {PerformanceEvents} eventName
		* @param {string} correlationId
		* @returns {number}
		*/
		getPreQueueTime(eventName, correlationId) {
			const preQueueEvent = this.preQueueTimeByCorrelationId.get(correlationId);
			if (!preQueueEvent) {
				this.logger.trace(`PerformanceClient.getPreQueueTime: no pre-queue times found for correlationId: ${correlationId}, unable to add queue measurement`);
				return;
			} else if (preQueueEvent.name !== eventName) {
				this.logger.trace(`PerformanceClient.getPreQueueTime: no pre-queue time found for ${eventName}, unable to add queue measurement`);
				return;
			}
			return preQueueEvent.time;
		}
		/**
		* Calculates the difference between current time and time when function was queued.
		* Note: It is possible to have 0 as the queue time if the current time and the queued time was the same.
		*
		* @param {number} preQueueTime
		* @param {number} currentTime
		* @returns {number}
		*/
		calculateQueuedTime(preQueueTime, currentTime) {
			if (preQueueTime < 1) {
				this.logger.trace(`PerformanceClient: preQueueTime should be a positive integer and not ${preQueueTime}`);
				return 0;
			}
			if (currentTime < 1) {
				this.logger.trace(`PerformanceClient: currentTime should be a positive integer and not ${currentTime}`);
				return 0;
			}
			if (currentTime < preQueueTime) {
				this.logger.trace("PerformanceClient: currentTime is less than preQueueTime, check how time is being retrieved");
				return 0;
			}
			return currentTime - preQueueTime;
		}
		/**
		* Adds queue measurement time to QueueMeasurements array for given correlation ID.
		*
		* @param {PerformanceEvents} eventName
		* @param {?string} correlationId
		* @param {?number} queueTime
		* @param {?boolean} manuallyCompleted - indicator for manually completed queue measurements
		* @returns
		*/
		addQueueMeasurement(eventName, correlationId, queueTime, manuallyCompleted) {
			if (!correlationId) {
				this.logger.trace(`PerformanceClient.addQueueMeasurement: correlationId not provided for ${eventName}, cannot add queue measurement`);
				return;
			}
			if (queueTime === 0) this.logger.trace(`PerformanceClient.addQueueMeasurement: queue time provided for ${eventName} is ${queueTime}`);
			else if (!queueTime) {
				this.logger.trace(`PerformanceClient.addQueueMeasurement: no queue time provided for ${eventName}`);
				return;
			}
			const queueMeasurement = {
				eventName,
				queueTime: manuallyCompleted ? 0 : queueTime,
				manuallyCompleted
			};
			const existingMeasurements = this.queueMeasurements.get(correlationId);
			if (existingMeasurements) {
				existingMeasurements.push(queueMeasurement);
				this.queueMeasurements.set(correlationId, existingMeasurements);
			} else {
				this.logger.trace(`PerformanceClient.addQueueMeasurement: adding correlationId ${correlationId} to queue measurements`);
				const measurementArray = [queueMeasurement];
				this.queueMeasurements.set(correlationId, measurementArray);
			}
			this.preQueueTimeByCorrelationId.delete(correlationId);
		}
		/**
		* Starts measuring performance for a given operation. Returns a function that should be used to end the measurement.
		*
		* @param {PerformanceEvents} measureName
		* @param {?string} [correlationId]
		* @returns {InProgressPerformanceEvent}
		*/
		startMeasurement(measureName, correlationId) {
			const eventCorrelationId = correlationId || this.generateId();
			if (!correlationId) this.logger.info(`PerformanceClient: No correlation id provided for ${measureName}, generating`, eventCorrelationId);
			this.logger.trace(`PerformanceClient: Performance measurement started for ${measureName}`, eventCorrelationId);
			const inProgressEvent = {
				eventId: this.generateId(),
				status: indexNode.PerformanceEventStatus.InProgress,
				authority: this.authority,
				libraryName: this.libraryName,
				libraryVersion: this.libraryVersion,
				clientId: this.clientId,
				name: measureName,
				startTimeMs: Date.now(),
				correlationId: eventCorrelationId,
				appName: this.applicationTelemetry?.appName,
				appVersion: this.applicationTelemetry?.appVersion
			};
			this.cacheEventByCorrelationId(inProgressEvent);
			startContext(inProgressEvent, this.abbreviations, this.eventStack.get(eventCorrelationId));
			return {
				end: (event, error, account) => {
					return this.endMeasurement({
						...inProgressEvent,
						...event
					}, error, account);
				},
				discard: () => {
					return this.discardMeasurements(inProgressEvent.correlationId);
				},
				add: (fields) => {
					return this.addFields(fields, inProgressEvent.correlationId);
				},
				increment: (fields) => {
					return this.incrementFields(fields, inProgressEvent.correlationId);
				},
				event: inProgressEvent,
				measurement: new indexNode.StubPerformanceMeasurement()
			};
		}
		/**
		* Stops measuring the performance for an operation. Should only be called directly by PerformanceClient classes,
		* as consumers should instead use the function returned by startMeasurement.
		* Adds a new field named as "[event name]DurationMs" for sub-measurements, completes and emits an event
		* otherwise.
		*
		* @param {PerformanceEvent} event
		* @param {unknown} error
		* @param {AccountInfo?} account
		* @returns {(PerformanceEvent | null)}
		*/
		endMeasurement(event, error, account) {
			const rootEvent = this.eventsByCorrelationId.get(event.correlationId);
			if (!rootEvent) {
				this.logger.trace(`PerformanceClient: Measurement not found for ${event.eventId}`, event.correlationId);
				return null;
			}
			const isRoot = event.eventId === rootEvent.eventId;
			let queueInfo = {
				totalQueueTime: 0,
				totalQueueCount: 0,
				manuallyCompletedCount: 0
			};
			event.durationMs = Math.round(event.durationMs || this.getDurationMs(event.startTimeMs));
			const context = JSON.stringify(endContext(event, this.abbreviations, this.eventStack.get(rootEvent.correlationId), error));
			if (isRoot) {
				queueInfo = this.getQueueInfo(event.correlationId);
				this.discardMeasurements(rootEvent.correlationId);
			} else rootEvent.incompleteSubMeasurements?.delete(event.eventId);
			this.logger.trace(`PerformanceClient: Performance measurement ended for ${event.name}: ${event.durationMs} ms`, event.correlationId);
			if (error) addError(error, this.logger, rootEvent);
			if (!isRoot) {
				rootEvent[event.name + "DurationMs"] = Math.floor(event.durationMs);
				return { ...rootEvent };
			}
			if (isRoot && !error && (rootEvent.errorCode || rootEvent.subErrorCode)) {
				this.logger.trace(`PerformanceClient: Remove error and sub-error codes for root event ${event.name} as intermediate error was successfully handled`, event.correlationId);
				rootEvent.errorCode = void 0;
				rootEvent.subErrorCode = void 0;
			}
			let finalEvent = {
				...rootEvent,
				...event
			};
			let incompleteSubsCount = 0;
			finalEvent.incompleteSubMeasurements?.forEach((subMeasurement) => {
				this.logger.trace(`PerformanceClient: Incomplete submeasurement ${subMeasurement.name} found for ${event.name}`, finalEvent.correlationId);
				incompleteSubsCount++;
			});
			finalEvent.incompleteSubMeasurements = void 0;
			finalEvent = {
				...finalEvent,
				queuedTimeMs: queueInfo.totalQueueTime,
				queuedCount: queueInfo.totalQueueCount,
				queuedManuallyCompletedCount: queueInfo.manuallyCompletedCount,
				status: indexNode.PerformanceEventStatus.Completed,
				incompleteSubsCount,
				context
			};
			if (account) {
				finalEvent.accountType = getAccountType(account);
				finalEvent.dataBoundary = account.dataBoundary;
			}
			this.truncateIntegralFields(finalEvent);
			this.emitEvents([finalEvent], event.correlationId);
			return finalEvent;
		}
		/**
		* Saves extra information to be emitted when the measurements are flushed
		* @param fields
		* @param correlationId
		*/
		addFields(fields, correlationId) {
			this.logger.trace("PerformanceClient: Updating static fields");
			const event = this.eventsByCorrelationId.get(correlationId);
			if (event) this.eventsByCorrelationId.set(correlationId, {
				...event,
				...fields
			});
			else this.logger.trace("PerformanceClient: Event not found for", correlationId);
		}
		/**
		* Increment counters to be emitted when the measurements are flushed
		* @param fields {string[]}
		* @param correlationId {string} correlation identifier
		*/
		incrementFields(fields, correlationId) {
			this.logger.trace("PerformanceClient: Updating counters");
			const event = this.eventsByCorrelationId.get(correlationId);
			if (event) for (const counter in fields) {
				if (!event.hasOwnProperty(counter)) event[counter] = 0;
				else if (isNaN(Number(event[counter]))) return;
				event[counter] += fields[counter];
			}
			else this.logger.trace("PerformanceClient: Event not found for", correlationId);
		}
		/**
		* Upserts event into event cache.
		* First key is the correlation id, second key is the event id.
		* Allows for events to be grouped by correlation id,
		* and to easily allow for properties on them to be updated.
		*
		* @private
		* @param {PerformanceEvent} event
		*/
		cacheEventByCorrelationId(event) {
			const rootEvent = this.eventsByCorrelationId.get(event.correlationId);
			if (rootEvent) {
				this.logger.trace(`PerformanceClient: Performance measurement for ${event.name} added/updated`, event.correlationId);
				rootEvent.incompleteSubMeasurements = rootEvent.incompleteSubMeasurements || /* @__PURE__ */ new Map();
				rootEvent.incompleteSubMeasurements.set(event.eventId, {
					name: event.name,
					startTimeMs: event.startTimeMs
				});
			} else {
				this.logger.trace(`PerformanceClient: Performance measurement for ${event.name} started`, event.correlationId);
				this.eventsByCorrelationId.set(event.correlationId, { ...event });
				this.eventStack.set(event.correlationId, []);
			}
		}
		getQueueInfo(correlationId) {
			const queueMeasurementForCorrelationId = this.queueMeasurements.get(correlationId);
			if (!queueMeasurementForCorrelationId) this.logger.trace(`PerformanceClient: no queue measurements found for for correlationId: ${correlationId}`);
			let totalQueueTime = 0;
			let totalQueueCount = 0;
			let manuallyCompletedCount = 0;
			queueMeasurementForCorrelationId?.forEach((measurement) => {
				totalQueueTime += measurement.queueTime;
				totalQueueCount++;
				manuallyCompletedCount += measurement.manuallyCompleted ? 1 : 0;
			});
			return {
				totalQueueTime,
				totalQueueCount,
				manuallyCompletedCount
			};
		}
		/**
		* Removes measurements and aux data for a given correlation id.
		*
		* @param {string} correlationId
		*/
		discardMeasurements(correlationId) {
			this.logger.trace("PerformanceClient: Performance measurements discarded", correlationId);
			this.eventsByCorrelationId.delete(correlationId);
			this.logger.trace("PerformanceClient: QueueMeasurements discarded", correlationId);
			this.queueMeasurements.delete(correlationId);
			this.logger.trace("PerformanceClient: Pre-queue times discarded", correlationId);
			this.preQueueTimeByCorrelationId.delete(correlationId);
			this.logger.trace("PerformanceClient: Event stack discarded", correlationId);
			this.eventStack.delete(correlationId);
		}
		/**
		* Registers a callback function to receive performance events.
		*
		* @param {PerformanceCallbackFunction} callback
		* @returns {string}
		*/
		addPerformanceCallback(callback) {
			for (const [id, cb] of this.callbacks) if (cb.toString() === callback.toString()) {
				this.logger.warning(`PerformanceClient: Performance callback is already registered with id: ${id}`);
				return id;
			}
			const callbackId = this.generateId();
			this.callbacks.set(callbackId, callback);
			this.logger.verbose(`PerformanceClient: Performance callback registered with id: ${callbackId}`);
			return callbackId;
		}
		/**
		* Removes a callback registered with addPerformanceCallback.
		*
		* @param {string} callbackId
		* @returns {boolean}
		*/
		removePerformanceCallback(callbackId) {
			const result = this.callbacks.delete(callbackId);
			if (result) this.logger.verbose(`PerformanceClient: Performance callback ${callbackId} removed.`);
			else this.logger.verbose(`PerformanceClient: Performance callback ${callbackId} not removed.`);
			return result;
		}
		/**
		* Emits events to all registered callbacks.
		*
		* @param {PerformanceEvent[]} events
		* @param {?string} [correlationId]
		*/
		emitEvents(events, correlationId) {
			this.logger.verbose("PerformanceClient: Emitting performance events", correlationId);
			this.callbacks.forEach((callback, callbackId) => {
				this.logger.trace(`PerformanceClient: Emitting event to callback ${callbackId}`, correlationId);
				callback.apply(null, [events]);
			});
		}
		/**
		* Enforce truncation of integral fields in performance event.
		* @param {PerformanceEvent} event performance event to update.
		*/
		truncateIntegralFields(event) {
			this.intFields.forEach((key) => {
				if (key in event && typeof event[key] === "number") event[key] = Math.floor(event[key]);
			});
		}
		/**
		* Returns event duration in milliseconds
		* @param startTimeMs {number}
		* @returns {number}
		*/
		getDurationMs(startTimeMs) {
			const durationMs = Date.now() - startTimeMs;
			return durationMs < 0 ? durationMs : 0;
		}
	};
	exports.AADAuthorityConstants = indexNode.AADAuthorityConstants;
	exports.AADServerParamKeys = indexNode.AADServerParamKeys;
	exports.AccountEntity = indexNode.AccountEntity;
	exports.AuthError = indexNode.AuthError;
	exports.AuthErrorCodes = indexNode.AuthErrorCodes;
	exports.AuthErrorMessage = indexNode.AuthErrorMessage;
	exports.AuthToken = indexNode.AuthToken;
	exports.AuthenticationHeaderParser = indexNode.AuthenticationHeaderParser;
	exports.AuthenticationScheme = indexNode.AuthenticationScheme;
	exports.Authority = indexNode.Authority;
	exports.AuthorityFactory = indexNode.AuthorityFactory;
	exports.AuthorityType = indexNode.AuthorityType;
	exports.AuthorizationCodeClient = indexNode.AuthorizationCodeClient;
	exports.AuthorizeProtocol = indexNode.Authorize;
	exports.AzureCloudInstance = indexNode.AzureCloudInstance;
	exports.BaseClient = indexNode.BaseClient;
	exports.CacheAccountType = indexNode.CacheAccountType;
	exports.CacheError = indexNode.CacheError;
	exports.CacheErrorCodes = indexNode.CacheErrorCodes;
	exports.CacheHelpers = indexNode.CacheHelpers;
	exports.CacheManager = indexNode.CacheManager;
	exports.CacheOutcome = indexNode.CacheOutcome;
	exports.CacheType = indexNode.CacheType;
	exports.CcsCredentialType = indexNode.CcsCredentialType;
	exports.ClaimsRequestKeys = indexNode.ClaimsRequestKeys;
	exports.ClientAuthError = indexNode.ClientAuthError;
	exports.ClientAuthErrorCodes = indexNode.ClientAuthErrorCodes;
	exports.ClientAuthErrorMessage = indexNode.ClientAuthErrorMessage;
	exports.ClientConfigurationError = indexNode.ClientConfigurationError;
	exports.ClientConfigurationErrorCodes = indexNode.ClientConfigurationErrorCodes;
	exports.ClientConfigurationErrorMessage = indexNode.ClientConfigurationErrorMessage;
	exports.CodeChallengeMethodValues = indexNode.CodeChallengeMethodValues;
	exports.Constants = indexNode.Constants;
	exports.CredentialType = indexNode.CredentialType;
	exports.DEFAULT_CRYPTO_IMPLEMENTATION = indexNode.DEFAULT_CRYPTO_IMPLEMENTATION;
	exports.DEFAULT_SYSTEM_OPTIONS = indexNode.DEFAULT_SYSTEM_OPTIONS;
	exports.DEFAULT_TOKEN_RENEWAL_OFFSET_SEC = indexNode.DEFAULT_TOKEN_RENEWAL_OFFSET_SEC;
	exports.DefaultStorageClass = indexNode.DefaultStorageClass;
	exports.EncodingTypes = indexNode.EncodingTypes;
	exports.Errors = indexNode.Errors;
	exports.GrantType = indexNode.GrantType;
	exports.HeaderNames = indexNode.HeaderNames;
	exports.HttpMethod = indexNode.HttpMethod;
	exports.HttpStatus = indexNode.HttpStatus;
	exports.IntFields = indexNode.IntFields;
	exports.InteractionRequiredAuthError = indexNode.InteractionRequiredAuthError;
	exports.InteractionRequiredAuthErrorCodes = indexNode.InteractionRequiredAuthErrorCodes;
	exports.InteractionRequiredAuthErrorMessage = indexNode.InteractionRequiredAuthErrorMessage;
	exports.JsonWebTokenTypes = indexNode.JsonWebTokenTypes;
	Object.defineProperty(exports, "LogLevel", {
		enumerable: true,
		get: function() {
			return indexNode.LogLevel;
		}
	});
	exports.Logger = indexNode.Logger;
	exports.NetworkError = indexNode.NetworkError;
	exports.OAuthResponseType = indexNode.OAuthResponseType;
	exports.OIDC_DEFAULT_SCOPES = indexNode.OIDC_DEFAULT_SCOPES;
	exports.ONE_DAY_IN_MS = indexNode.ONE_DAY_IN_MS;
	exports.PasswordGrantConstants = indexNode.PasswordGrantConstants;
	exports.PerformanceEventStatus = indexNode.PerformanceEventStatus;
	exports.PerformanceEvents = indexNode.PerformanceEvents;
	exports.PersistentCacheKeys = indexNode.PersistentCacheKeys;
	exports.PlatformBrokerError = indexNode.PlatformBrokerError;
	exports.PopTokenGenerator = indexNode.PopTokenGenerator;
	exports.PromptValue = indexNode.PromptValue;
	exports.ProtocolMode = indexNode.ProtocolMode;
	exports.ProtocolUtils = indexNode.ProtocolUtils;
	exports.RefreshTokenClient = indexNode.RefreshTokenClient;
	exports.RequestParameterBuilder = indexNode.RequestParameterBuilder;
	exports.ResponseHandler = indexNode.ResponseHandler;
	exports.ResponseMode = indexNode.ResponseMode;
	exports.ScopeSet = indexNode.ScopeSet;
	exports.ServerError = indexNode.ServerError;
	exports.ServerResponseType = indexNode.ServerResponseType;
	exports.ServerTelemetryManager = indexNode.ServerTelemetryManager;
	exports.SilentFlowClient = indexNode.SilentFlowClient;
	exports.StringUtils = indexNode.StringUtils;
	exports.StubPerformanceClient = indexNode.StubPerformanceClient;
	exports.StubbedNetworkModule = indexNode.StubbedNetworkModule;
	exports.THE_FAMILY_ID = indexNode.THE_FAMILY_ID;
	exports.ThrottlingConstants = indexNode.ThrottlingConstants;
	exports.ThrottlingUtils = indexNode.ThrottlingUtils;
	exports.TimeUtils = indexNode.TimeUtils;
	exports.UrlString = indexNode.UrlString;
	exports.UrlUtils = indexNode.UrlUtils;
	exports.buildAccountToCache = indexNode.buildAccountToCache;
	exports.buildClientInfo = indexNode.buildClientInfo;
	exports.buildClientInfoFromHomeAccountId = indexNode.buildClientInfoFromHomeAccountId;
	exports.buildStaticAuthorityOptions = indexNode.buildStaticAuthorityOptions;
	exports.buildTenantProfile = indexNode.buildTenantProfile;
	exports.createAuthError = indexNode.createAuthError;
	exports.createCacheError = indexNode.createCacheError;
	exports.createClientAuthError = indexNode.createClientAuthError;
	exports.createClientConfigurationError = indexNode.createClientConfigurationError;
	exports.createInteractionRequiredAuthError = indexNode.createInteractionRequiredAuthError;
	exports.createNetworkError = indexNode.createNetworkError;
	exports.formatAuthorityUri = indexNode.formatAuthorityUri;
	exports.getRequestThumbprint = indexNode.getRequestThumbprint;
	exports.getTenantIdFromIdTokenClaims = indexNode.getTenantIdFromIdTokenClaims;
	exports.invoke = indexNode.invoke;
	exports.invokeAsync = indexNode.invokeAsync;
	exports.tenantIdMatchesHomeTenant = indexNode.tenantIdMatchesHomeTenant;
	exports.updateAccountTenantProfileData = indexNode.updateAccountTenantProfileData;
	exports.version = indexNode.version;
	exports.JoseHeader = JoseHeader;
	exports.PerformanceClient = PerformanceClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/node_modules/@azure/msal-common/lib/index.cjs
/*! @azure/msal-common v15.17.0 2026-03-18 */
var require_lib = /* @__PURE__ */ __commonJSMin(((exports) => {
	var indexNode = require_index_node_Ddjhj5ij();
	var indexBrowser = require_index_browser();
	exports.AADAuthorityConstants = indexNode.AADAuthorityConstants;
	exports.AADServerParamKeys = indexNode.AADServerParamKeys;
	exports.AccountEntity = indexNode.AccountEntity;
	exports.AuthError = indexNode.AuthError;
	exports.AuthErrorCodes = indexNode.AuthErrorCodes;
	exports.AuthErrorMessage = indexNode.AuthErrorMessage;
	exports.AuthToken = indexNode.AuthToken;
	exports.AuthenticationHeaderParser = indexNode.AuthenticationHeaderParser;
	exports.AuthenticationScheme = indexNode.AuthenticationScheme;
	exports.Authority = indexNode.Authority;
	exports.AuthorityFactory = indexNode.AuthorityFactory;
	exports.AuthorityType = indexNode.AuthorityType;
	exports.AuthorizationCodeClient = indexNode.AuthorizationCodeClient;
	exports.AuthorizeProtocol = indexNode.Authorize;
	exports.AzureCloudInstance = indexNode.AzureCloudInstance;
	exports.BaseClient = indexNode.BaseClient;
	exports.CacheAccountType = indexNode.CacheAccountType;
	exports.CacheError = indexNode.CacheError;
	exports.CacheErrorCodes = indexNode.CacheErrorCodes;
	exports.CacheHelpers = indexNode.CacheHelpers;
	exports.CacheManager = indexNode.CacheManager;
	exports.CacheOutcome = indexNode.CacheOutcome;
	exports.CacheType = indexNode.CacheType;
	exports.CcsCredentialType = indexNode.CcsCredentialType;
	exports.ClaimsRequestKeys = indexNode.ClaimsRequestKeys;
	exports.ClientAssertionUtils = indexNode.ClientAssertionUtils;
	exports.ClientAuthError = indexNode.ClientAuthError;
	exports.ClientAuthErrorCodes = indexNode.ClientAuthErrorCodes;
	exports.ClientAuthErrorMessage = indexNode.ClientAuthErrorMessage;
	exports.ClientConfigurationError = indexNode.ClientConfigurationError;
	exports.ClientConfigurationErrorCodes = indexNode.ClientConfigurationErrorCodes;
	exports.ClientConfigurationErrorMessage = indexNode.ClientConfigurationErrorMessage;
	exports.CodeChallengeMethodValues = indexNode.CodeChallengeMethodValues;
	exports.Constants = indexNode.Constants;
	exports.CredentialType = indexNode.CredentialType;
	exports.DEFAULT_CRYPTO_IMPLEMENTATION = indexNode.DEFAULT_CRYPTO_IMPLEMENTATION;
	exports.DEFAULT_SYSTEM_OPTIONS = indexNode.DEFAULT_SYSTEM_OPTIONS;
	exports.DEFAULT_TOKEN_RENEWAL_OFFSET_SEC = indexNode.DEFAULT_TOKEN_RENEWAL_OFFSET_SEC;
	exports.DefaultStorageClass = indexNode.DefaultStorageClass;
	exports.EncodingTypes = indexNode.EncodingTypes;
	exports.Errors = indexNode.Errors;
	exports.GrantType = indexNode.GrantType;
	exports.HeaderNames = indexNode.HeaderNames;
	exports.HttpMethod = indexNode.HttpMethod;
	exports.HttpStatus = indexNode.HttpStatus;
	exports.IntFields = indexNode.IntFields;
	exports.InteractionRequiredAuthError = indexNode.InteractionRequiredAuthError;
	exports.InteractionRequiredAuthErrorCodes = indexNode.InteractionRequiredAuthErrorCodes;
	exports.InteractionRequiredAuthErrorMessage = indexNode.InteractionRequiredAuthErrorMessage;
	exports.JsonWebTokenTypes = indexNode.JsonWebTokenTypes;
	Object.defineProperty(exports, "LogLevel", {
		enumerable: true,
		get: function() {
			return indexNode.LogLevel;
		}
	});
	exports.Logger = indexNode.Logger;
	exports.NetworkError = indexNode.NetworkError;
	exports.OAuthResponseType = indexNode.OAuthResponseType;
	exports.OIDC_DEFAULT_SCOPES = indexNode.OIDC_DEFAULT_SCOPES;
	exports.ONE_DAY_IN_MS = indexNode.ONE_DAY_IN_MS;
	exports.PasswordGrantConstants = indexNode.PasswordGrantConstants;
	exports.PerformanceEventStatus = indexNode.PerformanceEventStatus;
	exports.PerformanceEvents = indexNode.PerformanceEvents;
	exports.PersistentCacheKeys = indexNode.PersistentCacheKeys;
	exports.PlatformBrokerError = indexNode.PlatformBrokerError;
	exports.PopTokenGenerator = indexNode.PopTokenGenerator;
	exports.PromptValue = indexNode.PromptValue;
	exports.ProtocolMode = indexNode.ProtocolMode;
	exports.ProtocolUtils = indexNode.ProtocolUtils;
	exports.RefreshTokenClient = indexNode.RefreshTokenClient;
	exports.RequestParameterBuilder = indexNode.RequestParameterBuilder;
	exports.ResponseHandler = indexNode.ResponseHandler;
	exports.ResponseMode = indexNode.ResponseMode;
	exports.ScopeSet = indexNode.ScopeSet;
	exports.ServerError = indexNode.ServerError;
	exports.ServerResponseType = indexNode.ServerResponseType;
	exports.ServerTelemetryManager = indexNode.ServerTelemetryManager;
	exports.SilentFlowClient = indexNode.SilentFlowClient;
	exports.StringUtils = indexNode.StringUtils;
	exports.StubPerformanceClient = indexNode.StubPerformanceClient;
	exports.StubbedNetworkModule = indexNode.StubbedNetworkModule;
	exports.THE_FAMILY_ID = indexNode.THE_FAMILY_ID;
	exports.ThrottlingConstants = indexNode.ThrottlingConstants;
	exports.ThrottlingUtils = indexNode.ThrottlingUtils;
	exports.TimeUtils = indexNode.TimeUtils;
	exports.TokenCacheContext = indexNode.TokenCacheContext;
	exports.UrlString = indexNode.UrlString;
	exports.UrlUtils = indexNode.UrlUtils;
	exports.buildAccountToCache = indexNode.buildAccountToCache;
	exports.buildClientInfo = indexNode.buildClientInfo;
	exports.buildClientInfoFromHomeAccountId = indexNode.buildClientInfoFromHomeAccountId;
	exports.buildStaticAuthorityOptions = indexNode.buildStaticAuthorityOptions;
	exports.buildTenantProfile = indexNode.buildTenantProfile;
	exports.createAuthError = indexNode.createAuthError;
	exports.createCacheError = indexNode.createCacheError;
	exports.createClientAuthError = indexNode.createClientAuthError;
	exports.createClientConfigurationError = indexNode.createClientConfigurationError;
	exports.createInteractionRequiredAuthError = indexNode.createInteractionRequiredAuthError;
	exports.createNetworkError = indexNode.createNetworkError;
	exports.formatAuthorityUri = indexNode.formatAuthorityUri;
	exports.getClientAssertion = indexNode.getClientAssertion;
	exports.getRequestThumbprint = indexNode.getRequestThumbprint;
	exports.getTenantIdFromIdTokenClaims = indexNode.getTenantIdFromIdTokenClaims;
	exports.invoke = indexNode.invoke;
	exports.invokeAsync = indexNode.invokeAsync;
	exports.tenantIdMatchesHomeTenant = indexNode.tenantIdMatchesHomeTenant;
	exports.updateAccountTenantProfileData = indexNode.updateAccountTenantProfileData;
	exports.version = indexNode.version;
	exports.JoseHeader = indexBrowser.JoseHeader;
	exports.PerformanceClient = indexBrowser.PerformanceClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/node_modules/@azure/msal-node/lib/msal-node.cjs
/*! @azure/msal-node v3.8.10 2026-03-18 */
var require_msal_node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = __require("http");
	var https = __require("https");
	var uuid = (init_dist_node(), __toCommonJS(dist_node_exports));
	var crypto$2 = __require("crypto");
	var msalCommon = require_lib();
	var jwt = require_jsonwebtoken();
	var fs = __require("fs");
	var path = __require("path");
	/**
	* This class serializes cache entities to be saved into in-memory object types defined internally
	* @internal
	*/
	var Serializer = class {
		/**
		* serialize the JSON blob
		* @param data - JSON blob cache
		*/
		static serializeJSONBlob(data) {
			return JSON.stringify(data);
		}
		/**
		* Serialize Accounts
		* @param accCache - cache of accounts
		*/
		static serializeAccounts(accCache) {
			const accounts = {};
			Object.keys(accCache).map(function(key) {
				const accountEntity = accCache[key];
				accounts[key] = {
					home_account_id: accountEntity.homeAccountId,
					environment: accountEntity.environment,
					realm: accountEntity.realm,
					local_account_id: accountEntity.localAccountId,
					username: accountEntity.username,
					authority_type: accountEntity.authorityType,
					name: accountEntity.name,
					client_info: accountEntity.clientInfo,
					last_modification_time: accountEntity.lastModificationTime,
					last_modification_app: accountEntity.lastModificationApp,
					tenantProfiles: accountEntity.tenantProfiles?.map((tenantProfile) => {
						return JSON.stringify(tenantProfile);
					})
				};
			});
			return accounts;
		}
		/**
		* Serialize IdTokens
		* @param idTCache - cache of ID tokens
		*/
		static serializeIdTokens(idTCache) {
			const idTokens = {};
			Object.keys(idTCache).map(function(key) {
				const idTEntity = idTCache[key];
				idTokens[key] = {
					home_account_id: idTEntity.homeAccountId,
					environment: idTEntity.environment,
					credential_type: idTEntity.credentialType,
					client_id: idTEntity.clientId,
					secret: idTEntity.secret,
					realm: idTEntity.realm
				};
			});
			return idTokens;
		}
		/**
		* Serializes AccessTokens
		* @param atCache - cache of access tokens
		*/
		static serializeAccessTokens(atCache) {
			const accessTokens = {};
			Object.keys(atCache).map(function(key) {
				const atEntity = atCache[key];
				accessTokens[key] = {
					home_account_id: atEntity.homeAccountId,
					environment: atEntity.environment,
					credential_type: atEntity.credentialType,
					client_id: atEntity.clientId,
					secret: atEntity.secret,
					realm: atEntity.realm,
					target: atEntity.target,
					cached_at: atEntity.cachedAt,
					expires_on: atEntity.expiresOn,
					extended_expires_on: atEntity.extendedExpiresOn,
					refresh_on: atEntity.refreshOn,
					key_id: atEntity.keyId,
					token_type: atEntity.tokenType,
					requestedClaims: atEntity.requestedClaims,
					requestedClaimsHash: atEntity.requestedClaimsHash,
					userAssertionHash: atEntity.userAssertionHash
				};
			});
			return accessTokens;
		}
		/**
		* Serialize refreshTokens
		* @param rtCache - cache of refresh tokens
		*/
		static serializeRefreshTokens(rtCache) {
			const refreshTokens = {};
			Object.keys(rtCache).map(function(key) {
				const rtEntity = rtCache[key];
				refreshTokens[key] = {
					home_account_id: rtEntity.homeAccountId,
					environment: rtEntity.environment,
					credential_type: rtEntity.credentialType,
					client_id: rtEntity.clientId,
					secret: rtEntity.secret,
					family_id: rtEntity.familyId,
					target: rtEntity.target,
					realm: rtEntity.realm
				};
			});
			return refreshTokens;
		}
		/**
		* Serialize amdtCache
		* @param amdtCache - cache of app metadata
		*/
		static serializeAppMetadata(amdtCache) {
			const appMetadata = {};
			Object.keys(amdtCache).map(function(key) {
				const amdtEntity = amdtCache[key];
				appMetadata[key] = {
					client_id: amdtEntity.clientId,
					environment: amdtEntity.environment,
					family_id: amdtEntity.familyId
				};
			});
			return appMetadata;
		}
		/**
		* Serialize the cache
		* @param inMemCache - itemised cache read from the JSON
		*/
		static serializeAllCache(inMemCache) {
			return {
				Account: this.serializeAccounts(inMemCache.accounts),
				IdToken: this.serializeIdTokens(inMemCache.idTokens),
				AccessToken: this.serializeAccessTokens(inMemCache.accessTokens),
				RefreshToken: this.serializeRefreshTokens(inMemCache.refreshTokens),
				AppMetadata: this.serializeAppMetadata(inMemCache.appMetadata)
			};
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const Constants$1 = {
		LIBRARY_NAME: "MSAL.JS",
		SKU: "msal.js.common",
		DEFAULT_AUTHORITY: "https://login.microsoftonline.com/common/",
		DEFAULT_AUTHORITY_HOST: "login.microsoftonline.com",
		DEFAULT_COMMON_TENANT: "common",
		ADFS: "adfs",
		DSTS: "dstsv2",
		AAD_INSTANCE_DISCOVERY_ENDPT: "https://login.microsoftonline.com/common/discovery/instance?api-version=1.1&authorization_endpoint=",
		CIAM_AUTH_URL: ".ciamlogin.com",
		AAD_TENANT_DOMAIN_SUFFIX: ".onmicrosoft.com",
		RESOURCE_DELIM: "|",
		NO_ACCOUNT: "NO_ACCOUNT",
		CLAIMS: "claims",
		CONSUMER_UTID: "9188040d-6c67-4c5b-b112-36a304b66dad",
		OPENID_SCOPE: "openid",
		PROFILE_SCOPE: "profile",
		OFFLINE_ACCESS_SCOPE: "offline_access",
		EMAIL_SCOPE: "email",
		CODE_GRANT_TYPE: "authorization_code",
		RT_GRANT_TYPE: "refresh_token",
		S256_CODE_CHALLENGE_METHOD: "S256",
		URL_FORM_CONTENT_TYPE: "application/x-www-form-urlencoded;charset=utf-8",
		AUTHORIZATION_PENDING: "authorization_pending",
		NOT_DEFINED: "not_defined",
		EMPTY_STRING: "",
		NOT_APPLICABLE: "N/A",
		NOT_AVAILABLE: "Not Available",
		FORWARD_SLASH: "/",
		IMDS_ENDPOINT: "http://169.254.169.254/metadata/instance/compute/location",
		IMDS_VERSION: "2020-06-01",
		IMDS_TIMEOUT: 2e3,
		AZURE_REGION_AUTO_DISCOVER_FLAG: "TryAutoDetect",
		REGIONAL_AUTH_PUBLIC_CLOUD_SUFFIX: "login.microsoft.com",
		KNOWN_PUBLIC_CLOUDS: [
			"login.microsoftonline.com",
			"login.windows.net",
			"login.microsoft.com",
			"sts.windows.net"
		],
		SHR_NONCE_VALIDITY: 240,
		INVALID_INSTANCE: "invalid_instance"
	};
	const HttpStatus = {
		SUCCESS: 200,
		SUCCESS_RANGE_START: 200,
		SUCCESS_RANGE_END: 299,
		REDIRECT: 302,
		CLIENT_ERROR: 400,
		CLIENT_ERROR_RANGE_START: 400,
		BAD_REQUEST: 400,
		UNAUTHORIZED: 401,
		NOT_FOUND: 404,
		REQUEST_TIMEOUT: 408,
		GONE: 410,
		TOO_MANY_REQUESTS: 429,
		CLIENT_ERROR_RANGE_END: 499,
		SERVER_ERROR: 500,
		SERVER_ERROR_RANGE_START: 500,
		SERVICE_UNAVAILABLE: 503,
		GATEWAY_TIMEOUT: 504,
		SERVER_ERROR_RANGE_END: 599,
		MULTI_SIDED_ERROR: 600
	};
	const OIDC_DEFAULT_SCOPES = [
		Constants$1.OPENID_SCOPE,
		Constants$1.PROFILE_SCOPE,
		Constants$1.OFFLINE_ACCESS_SCOPE
	];
	const OIDC_SCOPES = [...OIDC_DEFAULT_SCOPES, Constants$1.EMAIL_SCOPE];
	/**
	* Request header names
	*/
	const HeaderNames = {
		CONTENT_TYPE: "Content-Type",
		CONTENT_LENGTH: "Content-Length",
		RETRY_AFTER: "Retry-After",
		CCS_HEADER: "X-AnchorMailbox",
		WWWAuthenticate: "WWW-Authenticate",
		AuthenticationInfo: "Authentication-Info",
		X_MS_REQUEST_ID: "x-ms-request-id",
		X_MS_HTTP_VERSION: "x-ms-httpver"
	};
	/**
	* String constants related to AAD Authority
	*/
	const AADAuthorityConstants = {
		COMMON: "common",
		ORGANIZATIONS: "organizations",
		CONSUMERS: "consumers"
	};
	/**
	* Claims request keys
	*/
	const ClaimsRequestKeys = {
		ACCESS_TOKEN: "access_token",
		XMS_CC: "xms_cc"
	};
	/**
	* we considered making this "enum" in the request instead of string, however it looks like the allowed list of
	* prompt values kept changing over past couple of years. There are some undocumented prompt values for some
	* internal partners too, hence the choice of generic "string" type instead of the "enum"
	*/
	const PromptValue = {
		LOGIN: "login",
		SELECT_ACCOUNT: "select_account",
		CONSENT: "consent",
		NONE: "none",
		CREATE: "create",
		NO_SESSION: "no_session"
	};
	/**
	* allowed values for codeVerifier
	*/
	const CodeChallengeMethodValues = {
		PLAIN: "plain",
		S256: "S256"
	};
	/**
	* Allowed values for response_type
	*/
	const OAuthResponseType = {
		CODE: "code",
		IDTOKEN_TOKEN: "id_token token"
	};
	/**
	* allowed values for response_mode
	*/
	const ResponseMode = {
		QUERY: "query",
		FRAGMENT: "fragment",
		FORM_POST: "form_post"
	};
	/**
	* allowed grant_type
	*/
	const GrantType = {
		AUTHORIZATION_CODE_GRANT: "authorization_code",
		CLIENT_CREDENTIALS_GRANT: "client_credentials",
		RESOURCE_OWNER_PASSWORD_GRANT: "password",
		REFRESH_TOKEN_GRANT: "refresh_token",
		DEVICE_CODE_GRANT: "device_code",
		JWT_BEARER: "urn:ietf:params:oauth:grant-type:jwt-bearer"
	};
	/**
	* Account types in Cache
	*/
	const CacheAccountType = {
		MSSTS_ACCOUNT_TYPE: "MSSTS",
		ADFS_ACCOUNT_TYPE: "ADFS",
		GENERIC_ACCOUNT_TYPE: "Generic"
	};
	/**
	* Separators used in cache
	*/
	const Separators = {
		CACHE_KEY_SEPARATOR: "-",
		CLIENT_INFO_SEPARATOR: "."
	};
	/**
	* Credential Type stored in the cache
	*/
	const CredentialType = {
		ID_TOKEN: "IdToken",
		ACCESS_TOKEN: "AccessToken",
		ACCESS_TOKEN_WITH_AUTH_SCHEME: "AccessToken_With_AuthScheme",
		REFRESH_TOKEN: "RefreshToken"
	};
	/**
	* More Cache related constants
	*/
	const APP_METADATA = "appmetadata";
	const CLIENT_INFO = "client_info";
	const THE_FAMILY_ID = "1";
	const AUTHORITY_METADATA_CONSTANTS = {
		CACHE_KEY: "authority-metadata",
		REFRESH_TIME_SECONDS: 3600 * 24
	};
	const AuthorityMetadataSource = {
		CONFIG: "config",
		CACHE: "cache",
		NETWORK: "network",
		HARDCODED_VALUES: "hardcoded_values"
	};
	const SERVER_TELEM_CONSTANTS = {
		SCHEMA_VERSION: 5,
		MAX_LAST_HEADER_BYTES: 330,
		MAX_CACHED_ERRORS: 50,
		CACHE_KEY: "server-telemetry",
		CATEGORY_SEPARATOR: "|",
		VALUE_SEPARATOR: ",",
		OVERFLOW_TRUE: "1",
		OVERFLOW_FALSE: "0",
		UNKNOWN_ERROR: "unknown_error"
	};
	/**
	* Type of the authentication request
	*/
	const AuthenticationScheme = {
		BEARER: "Bearer",
		POP: "pop",
		SSH: "ssh-cert"
	};
	/**
	* Constants related to throttling
	*/
	const ThrottlingConstants = {
		DEFAULT_THROTTLE_TIME_SECONDS: 60,
		DEFAULT_MAX_THROTTLE_TIME_SECONDS: 3600,
		THROTTLING_PREFIX: "throttling",
		X_MS_LIB_CAPABILITY_VALUE: "retry-after, h429"
	};
	const Errors = {
		INVALID_GRANT_ERROR: "invalid_grant",
		CLIENT_MISMATCH_ERROR: "client_mismatch"
	};
	/**
	* Password grant parameters
	*/
	const PasswordGrantConstants = {
		username: "username",
		password: "password"
	};
	/**
	* Region Discovery Sources
	*/
	const RegionDiscoverySources = {
		FAILED_AUTO_DETECTION: "1",
		INTERNAL_CACHE: "2",
		ENVIRONMENT_VARIABLE: "3",
		IMDS: "4"
	};
	/**
	* Region Discovery Outcomes
	*/
	const RegionDiscoveryOutcomes = {
		CONFIGURED_NO_AUTO_DETECTION: "2",
		AUTO_DETECTION_REQUESTED_SUCCESSFUL: "4",
		AUTO_DETECTION_REQUESTED_FAILED: "5"
	};
	/**
	* Specifies the reason for fetching the access token from the identity provider
	*/
	const CacheOutcome = {
		NOT_APPLICABLE: "0",
		FORCE_REFRESH_OR_CLAIMS: "1",
		NO_CACHED_ACCESS_TOKEN: "2",
		CACHED_ACCESS_TOKEN_EXPIRED: "3",
		PROACTIVELY_REFRESHED: "4"
	};
	const DEFAULT_TOKEN_RENEWAL_OFFSET_SEC = 300;
	const EncodingTypes = {
		BASE64: "base64",
		HEX: "hex",
		UTF8: "utf-8"
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* AuthErrorMessage class containing string constants used by error codes and messages.
	*/
	const unexpectedError = "unexpected_error";
	const postRequestFailed = "post_request_failed";
	var AuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		postRequestFailed,
		unexpectedError
	});
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const AuthErrorMessages = {
		[unexpectedError]: "Unexpected error in authentication.",
		[postRequestFailed]: "Post request failed from the network, could be a 4xx/5xx or a network unavailability. Please check the exact error code for details."
	};
	/**
	* AuthErrorMessage class containing string constants used by error codes and messages.
	* @deprecated Use AuthErrorCodes instead
	*/
	const AuthErrorMessage = {
		unexpectedError: {
			code: unexpectedError,
			desc: AuthErrorMessages[unexpectedError]
		},
		postRequestFailed: {
			code: postRequestFailed,
			desc: AuthErrorMessages[postRequestFailed]
		}
	};
	/**
	* General error class thrown by the MSAL.js library.
	*/
	var AuthError = class AuthError extends Error {
		constructor(errorCode, errorMessage, suberror) {
			const errorString = errorMessage ? `${errorCode}: ${errorMessage}` : errorCode;
			super(errorString);
			Object.setPrototypeOf(this, AuthError.prototype);
			this.errorCode = errorCode || Constants$1.EMPTY_STRING;
			this.errorMessage = errorMessage || Constants$1.EMPTY_STRING;
			this.subError = suberror || Constants$1.EMPTY_STRING;
			this.name = "AuthError";
		}
		setCorrelationId(correlationId) {
			this.correlationId = correlationId;
		}
	};
	function createAuthError(code, additionalMessage) {
		return new AuthError(code, additionalMessage ? `${AuthErrorMessages[code]} ${additionalMessage}` : AuthErrorMessages[code]);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const clientInfoDecodingError = "client_info_decoding_error";
	const clientInfoEmptyError = "client_info_empty_error";
	const tokenParsingError = "token_parsing_error";
	const nullOrEmptyToken = "null_or_empty_token";
	const endpointResolutionError = "endpoints_resolution_error";
	const networkError = "network_error";
	const openIdConfigError = "openid_config_error";
	const hashNotDeserialized = "hash_not_deserialized";
	const invalidState = "invalid_state";
	const stateMismatch = "state_mismatch";
	const stateNotFound = "state_not_found";
	const nonceMismatch = "nonce_mismatch";
	const authTimeNotFound = "auth_time_not_found";
	const maxAgeTranspired = "max_age_transpired";
	const multipleMatchingTokens = "multiple_matching_tokens";
	const multipleMatchingAccounts = "multiple_matching_accounts";
	const multipleMatchingAppMetadata = "multiple_matching_appMetadata";
	const requestCannotBeMade = "request_cannot_be_made";
	const cannotRemoveEmptyScope = "cannot_remove_empty_scope";
	const cannotAppendScopeSet = "cannot_append_scopeset";
	const emptyInputScopeSet = "empty_input_scopeset";
	const deviceCodePollingCancelled = "device_code_polling_cancelled";
	const deviceCodeExpired = "device_code_expired";
	const deviceCodeUnknownError = "device_code_unknown_error";
	const noAccountInSilentRequest = "no_account_in_silent_request";
	const invalidCacheRecord = "invalid_cache_record";
	const invalidCacheEnvironment = "invalid_cache_environment";
	const noAccountFound = "no_account_found";
	const noCryptoObject = "no_crypto_object";
	const unexpectedCredentialType = "unexpected_credential_type";
	const invalidAssertion = "invalid_assertion";
	const invalidClientCredential = "invalid_client_credential";
	const tokenRefreshRequired = "token_refresh_required";
	const userTimeoutReached = "user_timeout_reached";
	const tokenClaimsCnfRequiredForSignedJwt = "token_claims_cnf_required_for_signedjwt";
	const authorizationCodeMissingFromServerResponse = "authorization_code_missing_from_server_response";
	const bindingKeyNotRemoved = "binding_key_not_removed";
	const endSessionEndpointNotSupported = "end_session_endpoint_not_supported";
	const keyIdMissing = "key_id_missing";
	const noNetworkConnectivity = "no_network_connectivity";
	const userCanceled = "user_canceled";
	const missingTenantIdError = "missing_tenant_id_error";
	const methodNotImplemented = "method_not_implemented";
	const nestedAppAuthBridgeDisabled = "nested_app_auth_bridge_disabled";
	const platformBrokerError = "platform_broker_error";
	var ClientAuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		authTimeNotFound,
		authorizationCodeMissingFromServerResponse,
		bindingKeyNotRemoved,
		cannotAppendScopeSet,
		cannotRemoveEmptyScope,
		clientInfoDecodingError,
		clientInfoEmptyError,
		deviceCodeExpired,
		deviceCodePollingCancelled,
		deviceCodeUnknownError,
		emptyInputScopeSet,
		endSessionEndpointNotSupported,
		endpointResolutionError,
		hashNotDeserialized,
		invalidAssertion,
		invalidCacheEnvironment,
		invalidCacheRecord,
		invalidClientCredential,
		invalidState,
		keyIdMissing,
		maxAgeTranspired,
		methodNotImplemented,
		missingTenantIdError,
		multipleMatchingAccounts,
		multipleMatchingAppMetadata,
		multipleMatchingTokens,
		nestedAppAuthBridgeDisabled,
		networkError,
		noAccountFound,
		noAccountInSilentRequest,
		noCryptoObject,
		noNetworkConnectivity,
		nonceMismatch,
		nullOrEmptyToken,
		openIdConfigError,
		platformBrokerError,
		requestCannotBeMade,
		stateMismatch,
		stateNotFound,
		tokenClaimsCnfRequiredForSignedJwt,
		tokenParsingError,
		tokenRefreshRequired,
		unexpectedCredentialType,
		userCanceled,
		userTimeoutReached
	});
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* ClientAuthErrorMessage class containing string constants used by error codes and messages.
	*/
	const ClientAuthErrorMessages = {
		[clientInfoDecodingError]: "The client info could not be parsed/decoded correctly",
		[clientInfoEmptyError]: "The client info was empty",
		[tokenParsingError]: "Token cannot be parsed",
		[nullOrEmptyToken]: "The token is null or empty",
		[endpointResolutionError]: "Endpoints cannot be resolved",
		[networkError]: "Network request failed",
		[openIdConfigError]: "Could not retrieve endpoints. Check your authority and verify the .well-known/openid-configuration endpoint returns the required endpoints.",
		[hashNotDeserialized]: "The hash parameters could not be deserialized",
		[invalidState]: "State was not the expected format",
		[stateMismatch]: "State mismatch error",
		[stateNotFound]: "State not found",
		[nonceMismatch]: "Nonce mismatch error",
		[authTimeNotFound]: "Max Age was requested and the ID token is missing the auth_time variable. auth_time is an optional claim and is not enabled by default - it must be enabled. See https://aka.ms/msaljs/optional-claims for more information.",
		[maxAgeTranspired]: "Max Age is set to 0, or too much time has elapsed since the last end-user authentication.",
		[multipleMatchingTokens]: "The cache contains multiple tokens satisfying the requirements. Call AcquireToken again providing more requirements such as authority or account.",
		[multipleMatchingAccounts]: "The cache contains multiple accounts satisfying the given parameters. Please pass more info to obtain the correct account",
		[multipleMatchingAppMetadata]: "The cache contains multiple appMetadata satisfying the given parameters. Please pass more info to obtain the correct appMetadata",
		[requestCannotBeMade]: "Token request cannot be made without authorization code or refresh token.",
		[cannotRemoveEmptyScope]: "Cannot remove null or empty scope from ScopeSet",
		[cannotAppendScopeSet]: "Cannot append ScopeSet",
		[emptyInputScopeSet]: "Empty input ScopeSet cannot be processed",
		[deviceCodePollingCancelled]: "Caller has cancelled token endpoint polling during device code flow by setting DeviceCodeRequest.cancel = true.",
		[deviceCodeExpired]: "Device code is expired.",
		[deviceCodeUnknownError]: "Device code stopped polling for unknown reasons.",
		[noAccountInSilentRequest]: "Please pass an account object, silent flow is not supported without account information",
		[invalidCacheRecord]: "Cache record object was null or undefined.",
		[invalidCacheEnvironment]: "Invalid environment when attempting to create cache entry",
		[noAccountFound]: "No account found in cache for given key.",
		[noCryptoObject]: "No crypto object detected.",
		[unexpectedCredentialType]: "Unexpected credential type.",
		[invalidAssertion]: "Client assertion must meet requirements described in https://tools.ietf.org/html/rfc7515",
		[invalidClientCredential]: "Client credential (secret, certificate, or assertion) must not be empty when creating a confidential client. An application should at most have one credential",
		[tokenRefreshRequired]: "Cannot return token from cache because it must be refreshed. This may be due to one of the following reasons: forceRefresh parameter is set to true, claims have been requested, there is no cached access token or it is expired.",
		[userTimeoutReached]: "User defined timeout for device code polling reached",
		[tokenClaimsCnfRequiredForSignedJwt]: "Cannot generate a POP jwt if the token_claims are not populated",
		[authorizationCodeMissingFromServerResponse]: "Server response does not contain an authorization code to proceed",
		[bindingKeyNotRemoved]: "Could not remove the credential's binding key from storage.",
		[endSessionEndpointNotSupported]: "The provided authority does not support logout",
		[keyIdMissing]: "A keyId value is missing from the requested bound token's cache record and is required to match the token to it's stored binding key.",
		[noNetworkConnectivity]: "No network connectivity. Check your internet connection.",
		[userCanceled]: "User cancelled the flow.",
		[missingTenantIdError]: "A tenant id - not common, organizations, or consumers - must be specified when using the client_credentials flow.",
		[methodNotImplemented]: "This method has not been implemented",
		[nestedAppAuthBridgeDisabled]: "The nested app auth bridge is disabled",
		[platformBrokerError]: "An error occurred in the native broker. See the platformBrokerError property for details."
	};
	/**
	* String constants used by error codes and messages.
	* @deprecated Use ClientAuthErrorCodes instead
	*/
	const ClientAuthErrorMessage = {
		clientInfoDecodingError: {
			code: clientInfoDecodingError,
			desc: ClientAuthErrorMessages[clientInfoDecodingError]
		},
		clientInfoEmptyError: {
			code: clientInfoEmptyError,
			desc: ClientAuthErrorMessages[clientInfoEmptyError]
		},
		tokenParsingError: {
			code: tokenParsingError,
			desc: ClientAuthErrorMessages[tokenParsingError]
		},
		nullOrEmptyToken: {
			code: nullOrEmptyToken,
			desc: ClientAuthErrorMessages[nullOrEmptyToken]
		},
		endpointResolutionError: {
			code: endpointResolutionError,
			desc: ClientAuthErrorMessages[endpointResolutionError]
		},
		networkError: {
			code: networkError,
			desc: ClientAuthErrorMessages[networkError]
		},
		unableToGetOpenidConfigError: {
			code: openIdConfigError,
			desc: ClientAuthErrorMessages[openIdConfigError]
		},
		hashNotDeserialized: {
			code: hashNotDeserialized,
			desc: ClientAuthErrorMessages[hashNotDeserialized]
		},
		invalidStateError: {
			code: invalidState,
			desc: ClientAuthErrorMessages[invalidState]
		},
		stateMismatchError: {
			code: stateMismatch,
			desc: ClientAuthErrorMessages[stateMismatch]
		},
		stateNotFoundError: {
			code: stateNotFound,
			desc: ClientAuthErrorMessages[stateNotFound]
		},
		nonceMismatchError: {
			code: nonceMismatch,
			desc: ClientAuthErrorMessages[nonceMismatch]
		},
		authTimeNotFoundError: {
			code: authTimeNotFound,
			desc: ClientAuthErrorMessages[authTimeNotFound]
		},
		maxAgeTranspired: {
			code: maxAgeTranspired,
			desc: ClientAuthErrorMessages[maxAgeTranspired]
		},
		multipleMatchingTokens: {
			code: multipleMatchingTokens,
			desc: ClientAuthErrorMessages[multipleMatchingTokens]
		},
		multipleMatchingAccounts: {
			code: multipleMatchingAccounts,
			desc: ClientAuthErrorMessages[multipleMatchingAccounts]
		},
		multipleMatchingAppMetadata: {
			code: multipleMatchingAppMetadata,
			desc: ClientAuthErrorMessages[multipleMatchingAppMetadata]
		},
		tokenRequestCannotBeMade: {
			code: requestCannotBeMade,
			desc: ClientAuthErrorMessages[requestCannotBeMade]
		},
		removeEmptyScopeError: {
			code: cannotRemoveEmptyScope,
			desc: ClientAuthErrorMessages[cannotRemoveEmptyScope]
		},
		appendScopeSetError: {
			code: cannotAppendScopeSet,
			desc: ClientAuthErrorMessages[cannotAppendScopeSet]
		},
		emptyInputScopeSetError: {
			code: emptyInputScopeSet,
			desc: ClientAuthErrorMessages[emptyInputScopeSet]
		},
		DeviceCodePollingCancelled: {
			code: deviceCodePollingCancelled,
			desc: ClientAuthErrorMessages[deviceCodePollingCancelled]
		},
		DeviceCodeExpired: {
			code: deviceCodeExpired,
			desc: ClientAuthErrorMessages[deviceCodeExpired]
		},
		DeviceCodeUnknownError: {
			code: deviceCodeUnknownError,
			desc: ClientAuthErrorMessages[deviceCodeUnknownError]
		},
		NoAccountInSilentRequest: {
			code: noAccountInSilentRequest,
			desc: ClientAuthErrorMessages[noAccountInSilentRequest]
		},
		invalidCacheRecord: {
			code: invalidCacheRecord,
			desc: ClientAuthErrorMessages[invalidCacheRecord]
		},
		invalidCacheEnvironment: {
			code: invalidCacheEnvironment,
			desc: ClientAuthErrorMessages[invalidCacheEnvironment]
		},
		noAccountFound: {
			code: noAccountFound,
			desc: ClientAuthErrorMessages[noAccountFound]
		},
		noCryptoObj: {
			code: noCryptoObject,
			desc: ClientAuthErrorMessages[noCryptoObject]
		},
		unexpectedCredentialType: {
			code: unexpectedCredentialType,
			desc: ClientAuthErrorMessages[unexpectedCredentialType]
		},
		invalidAssertion: {
			code: invalidAssertion,
			desc: ClientAuthErrorMessages[invalidAssertion]
		},
		invalidClientCredential: {
			code: invalidClientCredential,
			desc: ClientAuthErrorMessages[invalidClientCredential]
		},
		tokenRefreshRequired: {
			code: tokenRefreshRequired,
			desc: ClientAuthErrorMessages[tokenRefreshRequired]
		},
		userTimeoutReached: {
			code: userTimeoutReached,
			desc: ClientAuthErrorMessages[userTimeoutReached]
		},
		tokenClaimsRequired: {
			code: tokenClaimsCnfRequiredForSignedJwt,
			desc: ClientAuthErrorMessages[tokenClaimsCnfRequiredForSignedJwt]
		},
		noAuthorizationCodeFromServer: {
			code: authorizationCodeMissingFromServerResponse,
			desc: ClientAuthErrorMessages[authorizationCodeMissingFromServerResponse]
		},
		bindingKeyNotRemovedError: {
			code: bindingKeyNotRemoved,
			desc: ClientAuthErrorMessages[bindingKeyNotRemoved]
		},
		logoutNotSupported: {
			code: endSessionEndpointNotSupported,
			desc: ClientAuthErrorMessages[endSessionEndpointNotSupported]
		},
		keyIdMissing: {
			code: keyIdMissing,
			desc: ClientAuthErrorMessages[keyIdMissing]
		},
		noNetworkConnectivity: {
			code: noNetworkConnectivity,
			desc: ClientAuthErrorMessages[noNetworkConnectivity]
		},
		userCanceledError: {
			code: userCanceled,
			desc: ClientAuthErrorMessages[userCanceled]
		},
		missingTenantIdError: {
			code: missingTenantIdError,
			desc: ClientAuthErrorMessages[missingTenantIdError]
		},
		nestedAppAuthBridgeDisabled: {
			code: nestedAppAuthBridgeDisabled,
			desc: ClientAuthErrorMessages[nestedAppAuthBridgeDisabled]
		},
		platformBrokerError: {
			code: platformBrokerError,
			desc: ClientAuthErrorMessages[platformBrokerError]
		}
	};
	/**
	* Error thrown when there is an error in the client code running on the browser.
	*/
	var ClientAuthError = class ClientAuthError extends AuthError {
		constructor(errorCode, additionalMessage) {
			super(errorCode, additionalMessage ? `${ClientAuthErrorMessages[errorCode]}: ${additionalMessage}` : ClientAuthErrorMessages[errorCode]);
			this.name = "ClientAuthError";
			Object.setPrototypeOf(this, ClientAuthError.prototype);
		}
	};
	function createClientAuthError(errorCode, additionalMessage) {
		return new ClientAuthError(errorCode, additionalMessage);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const DEFAULT_CRYPTO_IMPLEMENTATION = {
		createNewGuid: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64Decode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64Encode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		base64UrlEncode: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		encodeKid: () => {
			throw createClientAuthError(methodNotImplemented);
		},
		async getPublicKeyThumbprint() {
			throw createClientAuthError(methodNotImplemented);
		},
		async removeTokenBindingKey() {
			throw createClientAuthError(methodNotImplemented);
		},
		async clearKeystore() {
			throw createClientAuthError(methodNotImplemented);
		},
		async signJwt() {
			throw createClientAuthError(methodNotImplemented);
		},
		async hashString() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Log message level.
	*/
	exports.LogLevel = void 0;
	(function(LogLevel) {
		LogLevel[LogLevel["Error"] = 0] = "Error";
		LogLevel[LogLevel["Warning"] = 1] = "Warning";
		LogLevel[LogLevel["Info"] = 2] = "Info";
		LogLevel[LogLevel["Verbose"] = 3] = "Verbose";
		LogLevel[LogLevel["Trace"] = 4] = "Trace";
	})(exports.LogLevel || (exports.LogLevel = {}));
	/**
	* Class which facilitates logging of messages to a specific place.
	*/
	var Logger = class Logger {
		constructor(loggerOptions, packageName, packageVersion) {
			this.level = exports.LogLevel.Info;
			const defaultLoggerCallback = () => {};
			const setLoggerOptions = loggerOptions || Logger.createDefaultLoggerOptions();
			this.localCallback = setLoggerOptions.loggerCallback || defaultLoggerCallback;
			this.piiLoggingEnabled = setLoggerOptions.piiLoggingEnabled || false;
			this.level = typeof setLoggerOptions.logLevel === "number" ? setLoggerOptions.logLevel : exports.LogLevel.Info;
			this.correlationId = setLoggerOptions.correlationId || Constants$1.EMPTY_STRING;
			this.packageName = packageName || Constants$1.EMPTY_STRING;
			this.packageVersion = packageVersion || Constants$1.EMPTY_STRING;
		}
		static createDefaultLoggerOptions() {
			return {
				loggerCallback: () => {},
				piiLoggingEnabled: false,
				logLevel: exports.LogLevel.Info
			};
		}
		/**
		* Create new Logger with existing configurations.
		*/
		clone(packageName, packageVersion, correlationId) {
			return new Logger({
				loggerCallback: this.localCallback,
				piiLoggingEnabled: this.piiLoggingEnabled,
				logLevel: this.level,
				correlationId: correlationId || this.correlationId
			}, packageName, packageVersion);
		}
		/**
		* Log message with required options.
		*/
		logMessage(logMessage, options) {
			if (options.logLevel > this.level || !this.piiLoggingEnabled && options.containsPii) return;
			const log = `${`[${(/* @__PURE__ */ new Date()).toUTCString()}] : [${options.correlationId || this.correlationId || ""}]`} : ${this.packageName}@${this.packageVersion} : ${exports.LogLevel[options.logLevel]} - ${logMessage}`;
			this.executeCallback(options.logLevel, log, options.containsPii || false);
		}
		/**
		* Execute callback with message.
		*/
		executeCallback(level, message, containsPii) {
			if (this.localCallback) this.localCallback(level, message, containsPii);
		}
		/**
		* Logs error messages.
		*/
		error(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Error,
				containsPii: false,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs error messages with PII.
		*/
		errorPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Error,
				containsPii: true,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs warning messages.
		*/
		warning(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Warning,
				containsPii: false,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs warning messages with PII.
		*/
		warningPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Warning,
				containsPii: true,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs info messages.
		*/
		info(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Info,
				containsPii: false,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs info messages with PII.
		*/
		infoPii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Info,
				containsPii: true,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs verbose messages.
		*/
		verbose(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Verbose,
				containsPii: false,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs verbose messages with PII.
		*/
		verbosePii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Verbose,
				containsPii: true,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs trace messages.
		*/
		trace(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Trace,
				containsPii: false,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Logs trace messages with PII.
		*/
		tracePii(message, correlationId) {
			this.logMessage(message, {
				logLevel: exports.LogLevel.Trace,
				containsPii: true,
				correlationId: correlationId || Constants$1.EMPTY_STRING
			});
		}
		/**
		* Returns whether PII Logging is enabled or not.
		*/
		isPiiLoggingEnabled() {
			return this.piiLoggingEnabled || false;
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const name$1 = "@azure/msal-common";
	const version$1 = "15.17.0";
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const AzureCloudInstance = {
		None: "none",
		AzurePublic: "https://login.microsoftonline.com",
		AzurePpe: "https://login.windows-ppe.net",
		AzureChina: "https://login.chinacloudapi.cn",
		AzureGermany: "https://login.microsoftonline.de",
		AzureUsGovernment: "https://login.microsoftonline.us"
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const redirectUriEmpty = "redirect_uri_empty";
	const claimsRequestParsingError = "claims_request_parsing_error";
	const authorityUriInsecure = "authority_uri_insecure";
	const urlParseError = "url_parse_error";
	const urlEmptyError = "empty_url_error";
	const emptyInputScopesError = "empty_input_scopes_error";
	const invalidClaims = "invalid_claims";
	const tokenRequestEmpty = "token_request_empty";
	const logoutRequestEmpty = "logout_request_empty";
	const invalidCodeChallengeMethod = "invalid_code_challenge_method";
	const pkceParamsMissing = "pkce_params_missing";
	const invalidCloudDiscoveryMetadata = "invalid_cloud_discovery_metadata";
	const invalidAuthorityMetadata = "invalid_authority_metadata";
	const untrustedAuthority = "untrusted_authority";
	const missingSshJwk = "missing_ssh_jwk";
	const missingSshKid = "missing_ssh_kid";
	const missingNonceAuthenticationHeader = "missing_nonce_authentication_header";
	const invalidAuthenticationHeader = "invalid_authentication_header";
	const cannotSetOIDCOptions = "cannot_set_OIDCOptions";
	const cannotAllowPlatformBroker = "cannot_allow_platform_broker";
	const authorityMismatch = "authority_mismatch";
	const invalidRequestMethodForEAR = "invalid_request_method_for_EAR";
	const invalidAuthorizePostBodyParameters = "invalid_authorize_post_body_parameters";
	const invalidPlatformBrokerConfiguration = "invalid_platform_broker_configuration";
	var ClientConfigurationErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		authorityMismatch,
		authorityUriInsecure,
		cannotAllowPlatformBroker,
		cannotSetOIDCOptions,
		claimsRequestParsingError,
		emptyInputScopesError,
		invalidAuthenticationHeader,
		invalidAuthorityMetadata,
		invalidAuthorizePostBodyParameters,
		invalidClaims,
		invalidCloudDiscoveryMetadata,
		invalidCodeChallengeMethod,
		invalidPlatformBrokerConfiguration,
		invalidRequestMethodForEAR,
		logoutRequestEmpty,
		missingNonceAuthenticationHeader,
		missingSshJwk,
		missingSshKid,
		pkceParamsMissing,
		redirectUriEmpty,
		tokenRequestEmpty,
		untrustedAuthority,
		urlEmptyError,
		urlParseError
	});
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const ClientConfigurationErrorMessages = {
		[redirectUriEmpty]: "A redirect URI is required for all calls, and none has been set.",
		[claimsRequestParsingError]: "Could not parse the given claims request object.",
		[authorityUriInsecure]: "Authority URIs must use https.  Please see here for valid authority configuration options: https://docs.microsoft.com/en-us/azure/active-directory/develop/msal-js-initializing-client-applications#configuration-options",
		[urlParseError]: "URL could not be parsed into appropriate segments.",
		[urlEmptyError]: "URL was empty or null.",
		[emptyInputScopesError]: "Scopes cannot be passed as null, undefined or empty array because they are required to obtain an access token.",
		[invalidClaims]: "Given claims parameter must be a stringified JSON object.",
		[tokenRequestEmpty]: "Token request was empty and not found in cache.",
		[logoutRequestEmpty]: "The logout request was null or undefined.",
		[invalidCodeChallengeMethod]: "code_challenge_method passed is invalid. Valid values are \"plain\" and \"S256\".",
		[pkceParamsMissing]: "Both params: code_challenge and code_challenge_method are to be passed if to be sent in the request",
		[invalidCloudDiscoveryMetadata]: "Invalid cloudDiscoveryMetadata provided. Must be a stringified JSON object containing tenant_discovery_endpoint and metadata fields",
		[invalidAuthorityMetadata]: "Invalid authorityMetadata provided. Must by a stringified JSON object containing authorization_endpoint, token_endpoint, issuer fields.",
		[untrustedAuthority]: "The provided authority is not a trusted authority. Please include this authority in the knownAuthorities config parameter.",
		[missingSshJwk]: "Missing sshJwk in SSH certificate request. A stringified JSON Web Key is required when using the SSH authentication scheme.",
		[missingSshKid]: "Missing sshKid in SSH certificate request. A string that uniquely identifies the public SSH key is required when using the SSH authentication scheme.",
		[missingNonceAuthenticationHeader]: "Unable to find an authentication header containing server nonce. Either the Authentication-Info or WWW-Authenticate headers must be present in order to obtain a server nonce.",
		[invalidAuthenticationHeader]: "Invalid authentication header provided",
		[cannotSetOIDCOptions]: "Cannot set OIDCOptions parameter. Please change the protocol mode to OIDC or use a non-Microsoft authority.",
		[cannotAllowPlatformBroker]: "Cannot set allowPlatformBroker parameter to true when not in AAD protocol mode.",
		[authorityMismatch]: "Authority mismatch error. Authority provided in login request or PublicClientApplication config does not match the environment of the provided account. Please use a matching account or make an interactive request to login to this authority.",
		[invalidAuthorizePostBodyParameters]: "Invalid authorize post body parameters provided. If you are using authorizePostBodyParameters, the request method must be POST. Please check the request method and parameters.",
		[invalidRequestMethodForEAR]: "Invalid request method for EAR protocol mode. The request method cannot be GET when using EAR protocol mode. Please change the request method to POST.",
		[invalidPlatformBrokerConfiguration]: "Invalid platform broker configuration. `allowPlatformBrokerWithDOM` can only be enabled when `allowPlatformBroker` is enabled."
	};
	/**
	* ClientConfigurationErrorMessage class containing string constants used by error codes and messages.
	* @deprecated Use ClientConfigurationErrorCodes instead
	*/
	const ClientConfigurationErrorMessage = {
		redirectUriNotSet: {
			code: redirectUriEmpty,
			desc: ClientConfigurationErrorMessages[redirectUriEmpty]
		},
		claimsRequestParsingError: {
			code: claimsRequestParsingError,
			desc: ClientConfigurationErrorMessages[claimsRequestParsingError]
		},
		authorityUriInsecure: {
			code: authorityUriInsecure,
			desc: ClientConfigurationErrorMessages[authorityUriInsecure]
		},
		urlParseError: {
			code: urlParseError,
			desc: ClientConfigurationErrorMessages[urlParseError]
		},
		urlEmptyError: {
			code: urlEmptyError,
			desc: ClientConfigurationErrorMessages[urlEmptyError]
		},
		emptyScopesError: {
			code: emptyInputScopesError,
			desc: ClientConfigurationErrorMessages[emptyInputScopesError]
		},
		invalidClaimsRequest: {
			code: invalidClaims,
			desc: ClientConfigurationErrorMessages[invalidClaims]
		},
		tokenRequestEmptyError: {
			code: tokenRequestEmpty,
			desc: ClientConfigurationErrorMessages[tokenRequestEmpty]
		},
		logoutRequestEmptyError: {
			code: logoutRequestEmpty,
			desc: ClientConfigurationErrorMessages[logoutRequestEmpty]
		},
		invalidCodeChallengeMethod: {
			code: invalidCodeChallengeMethod,
			desc: ClientConfigurationErrorMessages[invalidCodeChallengeMethod]
		},
		invalidCodeChallengeParams: {
			code: pkceParamsMissing,
			desc: ClientConfigurationErrorMessages[pkceParamsMissing]
		},
		invalidCloudDiscoveryMetadata: {
			code: invalidCloudDiscoveryMetadata,
			desc: ClientConfigurationErrorMessages[invalidCloudDiscoveryMetadata]
		},
		invalidAuthorityMetadata: {
			code: invalidAuthorityMetadata,
			desc: ClientConfigurationErrorMessages[invalidAuthorityMetadata]
		},
		untrustedAuthority: {
			code: untrustedAuthority,
			desc: ClientConfigurationErrorMessages[untrustedAuthority]
		},
		missingSshJwk: {
			code: missingSshJwk,
			desc: ClientConfigurationErrorMessages[missingSshJwk]
		},
		missingSshKid: {
			code: missingSshKid,
			desc: ClientConfigurationErrorMessages[missingSshKid]
		},
		missingNonceAuthenticationHeader: {
			code: missingNonceAuthenticationHeader,
			desc: ClientConfigurationErrorMessages[missingNonceAuthenticationHeader]
		},
		invalidAuthenticationHeader: {
			code: invalidAuthenticationHeader,
			desc: ClientConfigurationErrorMessages[invalidAuthenticationHeader]
		},
		cannotSetOIDCOptions: {
			code: cannotSetOIDCOptions,
			desc: ClientConfigurationErrorMessages[cannotSetOIDCOptions]
		},
		cannotAllowPlatformBroker: {
			code: cannotAllowPlatformBroker,
			desc: ClientConfigurationErrorMessages[cannotAllowPlatformBroker]
		},
		authorityMismatch: {
			code: authorityMismatch,
			desc: ClientConfigurationErrorMessages[authorityMismatch]
		},
		invalidAuthorizePostBodyParameters: {
			code: invalidAuthorizePostBodyParameters,
			desc: ClientConfigurationErrorMessages[invalidAuthorizePostBodyParameters]
		},
		invalidRequestMethodForEAR: {
			code: invalidRequestMethodForEAR,
			desc: ClientConfigurationErrorMessages[invalidRequestMethodForEAR]
		},
		invalidPlatformBrokerConfiguration: {
			code: invalidPlatformBrokerConfiguration,
			desc: ClientConfigurationErrorMessages[invalidPlatformBrokerConfiguration]
		}
	};
	/**
	* Error thrown when there is an error in configuration of the MSAL.js library.
	*/
	var ClientConfigurationError = class ClientConfigurationError extends AuthError {
		constructor(errorCode) {
			super(errorCode, ClientConfigurationErrorMessages[errorCode]);
			this.name = "ClientConfigurationError";
			Object.setPrototypeOf(this, ClientConfigurationError.prototype);
		}
	};
	function createClientConfigurationError(errorCode) {
		return new ClientConfigurationError(errorCode);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* @hidden
	*/
	var StringUtils = class {
		/**
		* Check if stringified object is empty
		* @param strObj
		*/
		static isEmptyObj(strObj) {
			if (strObj) try {
				const obj = JSON.parse(strObj);
				return Object.keys(obj).length === 0;
			} catch (e) {}
			return true;
		}
		static startsWith(str, search) {
			return str.indexOf(search) === 0;
		}
		static endsWith(str, search) {
			return str.length >= search.length && str.lastIndexOf(search) === str.length - search.length;
		}
		/**
		* Parses string into an object.
		*
		* @param query
		*/
		static queryStringToObject(query) {
			const obj = {};
			const params = query.split("&");
			const decode = (s) => decodeURIComponent(s.replace(/\+/g, " "));
			params.forEach((pair) => {
				if (pair.trim()) {
					const [key, value] = pair.split(/=(.+)/g, 2);
					if (key && value) obj[decode(key)] = decode(value);
				}
			});
			return obj;
		}
		/**
		* Trims entries in an array.
		*
		* @param arr
		*/
		static trimArrayEntries(arr) {
			return arr.map((entry) => entry.trim());
		}
		/**
		* Removes empty strings from array
		* @param arr
		*/
		static removeEmptyStringsFromArray(arr) {
			return arr.filter((entry) => {
				return !!entry;
			});
		}
		/**
		* Attempts to parse a string into JSON
		* @param str
		*/
		static jsonParseHelper(str) {
			try {
				return JSON.parse(str);
			} catch (e) {
				return null;
			}
		}
		/**
		* Tests if a given string matches a given pattern, with support for wildcards and queries.
		* @param pattern Wildcard pattern to string match. Supports "*" for wildcards and "?" for queries
		* @param input String to match against
		*/
		static matchPattern(pattern, input) {
			return new RegExp(pattern.replace(/\\/g, "\\\\").replace(/\*/g, "[^ ]*").replace(/\?/g, "\\?")).test(input);
		}
		/**
		* Tests if a given string matches a given pattern using stricter, anchored matching semantics.
		*
		* Differences from `matchPattern` (legacy):
		* - All regex metacharacters (including `.`) in the pattern are treated as literals,
		*   so `example.com` matches only `example.com` and not `exampleXcom`.
		* - The generated regex is anchored with `^` and `$` so partial/substring matches
		*   are not allowed.
		* - `*` is the only supported wildcard. Its behaviour depends on the URL component:
		*   - `host` component: `*` matches any sequence of characters that does NOT include
		*     a dot (`.`), keeping wildcards within a single DNS label boundary.
		*   - All other components: `*` matches any sequence of characters (including `/`).
		*
		* @param pattern - The `protectedResourceMap` key pattern to match against. `*` is a
		*   multi-character wildcard; all other characters are treated as literals.
		* @param input - The URL component value (e.g. host, pathname) extracted from the
		*   outgoing request URL to test against the pattern.
		* @param options - Optional. Provide `component` to enable component-aware wildcard
		*   semantics. Accepted values: `"host"`, `"path"`, `"protocol"`, `"search"`,
		*   `"hash"`. Defaults to path-style (permissive) matching when omitted.
		* @returns `true` if the full input string matches the pattern; `false` otherwise.
		*/
		static matchPatternStrict(pattern, input, options) {
			const component = options?.component;
			let regexBody = pattern.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
			if (component === "host") regexBody = regexBody.replace(/\\\*/g, "[^.]*");
			else regexBody = regexBody.replace(/\\\*/g, ".*");
			return new RegExp(`^${regexBody}$`).test(input);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* The ScopeSet class creates a set of scopes. Scopes are case-insensitive, unique values, so the Set object in JS makes
	* the most sense to implement for this class. All scopes are trimmed and converted to lower case strings in intersection and union functions
	* to ensure uniqueness of strings.
	*/
	var ScopeSet = class ScopeSet {
		constructor(inputScopes) {
			const scopeArr = inputScopes ? StringUtils.trimArrayEntries([...inputScopes]) : [];
			const filteredInput = scopeArr ? StringUtils.removeEmptyStringsFromArray(scopeArr) : [];
			if (!filteredInput || !filteredInput.length) throw createClientConfigurationError(emptyInputScopesError);
			this.scopes = /* @__PURE__ */ new Set();
			filteredInput.forEach((scope) => this.scopes.add(scope));
		}
		/**
		* Factory method to create ScopeSet from space-delimited string
		* @param inputScopeString
		* @param appClientId
		* @param scopesRequired
		*/
		static fromString(inputScopeString) {
			return new ScopeSet((inputScopeString || Constants$1.EMPTY_STRING).split(" "));
		}
		/**
		* Creates the set of scopes to search for in cache lookups
		* @param inputScopeString
		* @returns
		*/
		static createSearchScopes(inputScopeString) {
			const scopeSet = new ScopeSet(inputScopeString && inputScopeString.length > 0 ? inputScopeString : [...OIDC_DEFAULT_SCOPES]);
			if (!scopeSet.containsOnlyOIDCScopes()) scopeSet.removeOIDCScopes();
			else scopeSet.removeScope(Constants$1.OFFLINE_ACCESS_SCOPE);
			return scopeSet;
		}
		/**
		* Check if a given scope is present in this set of scopes.
		* @param scope
		*/
		containsScope(scope) {
			const lowerCaseScopesSet = new ScopeSet(this.printScopesLowerCase().split(" "));
			return scope ? lowerCaseScopesSet.scopes.has(scope.toLowerCase()) : false;
		}
		/**
		* Check if a set of scopes is present in this set of scopes.
		* @param scopeSet
		*/
		containsScopeSet(scopeSet) {
			if (!scopeSet || scopeSet.scopes.size <= 0) return false;
			return this.scopes.size >= scopeSet.scopes.size && scopeSet.asArray().every((scope) => this.containsScope(scope));
		}
		/**
		* Check if set of scopes contains only the defaults
		*/
		containsOnlyOIDCScopes() {
			let defaultScopeCount = 0;
			OIDC_SCOPES.forEach((defaultScope) => {
				if (this.containsScope(defaultScope)) defaultScopeCount += 1;
			});
			return this.scopes.size === defaultScopeCount;
		}
		/**
		* Appends single scope if passed
		* @param newScope
		*/
		appendScope(newScope) {
			if (newScope) this.scopes.add(newScope.trim());
		}
		/**
		* Appends multiple scopes if passed
		* @param newScopes
		*/
		appendScopes(newScopes) {
			try {
				newScopes.forEach((newScope) => this.appendScope(newScope));
			} catch (e) {
				throw createClientAuthError(cannotAppendScopeSet);
			}
		}
		/**
		* Removes element from set of scopes.
		* @param scope
		*/
		removeScope(scope) {
			if (!scope) throw createClientAuthError(cannotRemoveEmptyScope);
			this.scopes.delete(scope.trim());
		}
		/**
		* Removes default scopes from set of scopes
		* Primarily used to prevent cache misses if the default scopes are not returned from the server
		*/
		removeOIDCScopes() {
			OIDC_SCOPES.forEach((defaultScope) => {
				this.scopes.delete(defaultScope);
			});
		}
		/**
		* Combines an array of scopes with the current set of scopes.
		* @param otherScopes
		*/
		unionScopeSets(otherScopes) {
			if (!otherScopes) throw createClientAuthError(emptyInputScopeSet);
			const unionScopes = /* @__PURE__ */ new Set();
			otherScopes.scopes.forEach((scope) => unionScopes.add(scope.toLowerCase()));
			this.scopes.forEach((scope) => unionScopes.add(scope.toLowerCase()));
			return unionScopes;
		}
		/**
		* Check if scopes intersect between this set and another.
		* @param otherScopes
		*/
		intersectingScopeSets(otherScopes) {
			if (!otherScopes) throw createClientAuthError(emptyInputScopeSet);
			if (!otherScopes.containsOnlyOIDCScopes()) otherScopes.removeOIDCScopes();
			const unionScopes = this.unionScopeSets(otherScopes);
			const sizeOtherScopes = otherScopes.getScopeCount();
			const sizeThisScopes = this.getScopeCount();
			return unionScopes.size < sizeThisScopes + sizeOtherScopes;
		}
		/**
		* Returns size of set of scopes.
		*/
		getScopeCount() {
			return this.scopes.size;
		}
		/**
		* Returns the scopes as an array of string values
		*/
		asArray() {
			const array = [];
			this.scopes.forEach((val) => array.push(val));
			return array;
		}
		/**
		* Prints scopes into a space-delimited string
		*/
		printScopes() {
			if (this.scopes) return this.asArray().join(" ");
			return Constants$1.EMPTY_STRING;
		}
		/**
		* Prints scopes into a space-delimited lower-case string (used for caching)
		*/
		printScopesLowerCase() {
			return this.printScopes().toLowerCase();
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Function to build a client info object from server clientInfo string
	* @param rawClientInfo
	* @param crypto
	*/
	function buildClientInfo(rawClientInfo, base64Decode) {
		if (!rawClientInfo) throw createClientAuthError(clientInfoEmptyError);
		try {
			const decodedClientInfo = base64Decode(rawClientInfo);
			return JSON.parse(decodedClientInfo);
		} catch (e) {
			throw createClientAuthError(clientInfoDecodingError);
		}
	}
	/**
	* Function to build a client info object from cached homeAccountId string
	* @param homeAccountId
	*/
	function buildClientInfoFromHomeAccountId(homeAccountId) {
		if (!homeAccountId) throw createClientAuthError(clientInfoDecodingError);
		const clientInfoParts = homeAccountId.split(Separators.CLIENT_INFO_SEPARATOR, 2);
		return {
			uid: clientInfoParts[0],
			utid: clientInfoParts.length < 2 ? Constants$1.EMPTY_STRING : clientInfoParts[1]
		};
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Returns true if tenantId matches the utid portion of homeAccountId
	* @param tenantId
	* @param homeAccountId
	* @returns
	*/
	function tenantIdMatchesHomeTenant(tenantId, homeAccountId) {
		return !!tenantId && !!homeAccountId && tenantId === homeAccountId.split(".")[1];
	}
	/**
	* Build tenant profile
	* @param homeAccountId - Home account identifier for this account object
	* @param localAccountId - Local account identifer for this account object
	* @param tenantId - Full tenant or organizational id that this account belongs to
	* @param idTokenClaims - Claims from the ID token
	* @returns
	*/
	function buildTenantProfile(homeAccountId, localAccountId, tenantId, idTokenClaims) {
		if (idTokenClaims) {
			const { oid, sub, tid, name, tfp, acr, preferred_username, upn, login_hint } = idTokenClaims;
			/**
			* Since there is no way to determine if the authority is AAD or B2C, we exhaust all the possible claims that can serve as tenant ID with the following precedence:
			* tid - TenantID claim that identifies the tenant that issued the token in AAD. Expected in all AAD ID tokens, not present in B2C ID Tokens.
			* tfp - Trust Framework Policy claim that identifies the policy that was used to authenticate the user. Functions as tenant for B2C scenarios.
			* acr - Authentication Context Class Reference claim used only with older B2C policies. Fallback in case tfp is not present, but likely won't be present anyway.
			*/
			const tenantId = tid || tfp || acr || "";
			return {
				tenantId,
				localAccountId: oid || sub || "",
				name,
				username: preferred_username || upn || "",
				loginHint: login_hint,
				isHomeTenant: tenantIdMatchesHomeTenant(tenantId, homeAccountId)
			};
		} else return {
			tenantId,
			localAccountId,
			username: "",
			isHomeTenant: tenantIdMatchesHomeTenant(tenantId, homeAccountId)
		};
	}
	/**
	* Replaces account info that varies by tenant profile sourced from the ID token claims passed in with the tenant-specific account info
	* @param baseAccountInfo
	* @param idTokenClaims
	* @returns
	*/
	function updateAccountTenantProfileData(baseAccountInfo, tenantProfile, idTokenClaims, idTokenSecret) {
		let updatedAccountInfo = baseAccountInfo;
		if (tenantProfile) {
			const { isHomeTenant, ...tenantProfileOverride } = tenantProfile;
			updatedAccountInfo = {
				...baseAccountInfo,
				...tenantProfileOverride
			};
		}
		if (idTokenClaims) {
			const { isHomeTenant, ...claimsSourcedTenantProfile } = buildTenantProfile(baseAccountInfo.homeAccountId, baseAccountInfo.localAccountId, baseAccountInfo.tenantId, idTokenClaims);
			updatedAccountInfo = {
				...updatedAccountInfo,
				...claimsSourcedTenantProfile,
				idTokenClaims,
				idToken: idTokenSecret
			};
			return updatedAccountInfo;
		}
		return updatedAccountInfo;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Authority types supported by MSAL.
	*/
	const AuthorityType = {
		Default: 0,
		Adfs: 1,
		Dsts: 2,
		Ciam: 3
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Gets tenantId from available ID token claims to set as credential realm with the following precedence:
	* 1. tid - if the token is acquired from an Azure AD tenant tid will be present
	* 2. tfp - if the token is acquired from a modern B2C tenant tfp should be present
	* 3. acr - if the token is acquired from a legacy B2C tenant acr should be present
	* Downcased to match the realm case-insensitive comparison requirements
	* @param idTokenClaims
	* @returns
	*/
	function getTenantIdFromIdTokenClaims(idTokenClaims) {
		if (idTokenClaims) return idTokenClaims.tid || idTokenClaims.tfp || idTokenClaims.acr || null;
		return null;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Protocol modes supported by MSAL.
	*/
	const ProtocolMode = {
		/**
		* Auth Code + PKCE with Entra ID (formerly AAD) specific optimizations and features
		*/
		AAD: "AAD",
		/**
		* Auth Code + PKCE without Entra ID specific optimizations and features. For use only with non-Microsoft owned authorities.
		* Support is limited for this mode.
		*/
		OIDC: "OIDC",
		/**
		* Encrypted Authorize Response (EAR) with Entra ID specific optimizations and features
		*/
		EAR: "EAR"
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Type that defines required and optional parameters for an Account field (based on universal cache schema implemented by all MSALs).
	*
	* Key : Value Schema
	*
	* Key: <home_account_id>-<environment>-<realm*>
	*
	* Value Schema:
	* {
	*      homeAccountId: home account identifier for the auth scheme,
	*      environment: entity that issued the token, represented as a full host
	*      realm: Full tenant or organizational identifier that the account belongs to
	*      localAccountId: Original tenant-specific accountID, usually used for legacy cases
	*      username: primary username that represents the user, usually corresponds to preferred_username in the v2 endpt
	*      authorityType: Accounts authority type as a string
	*      name: Full name for the account, including given name and family name,
	*      lastModificationTime: last time this entity was modified in the cache
	*      lastModificationApp:
	*      nativeAccountId: Account identifier on the native device
	*      tenantProfiles: Array of tenant profile objects for each tenant that the account has authenticated with in the browser
	* }
	* @internal
	*/
	var AccountEntity = class AccountEntity {
		/**
		* Returns the AccountInfo interface for this account.
		*/
		static getAccountInfo(accountEntity) {
			const tenantProfiles = accountEntity.tenantProfiles || [];
			if (tenantProfiles.length === 0 && accountEntity.realm && accountEntity.localAccountId) tenantProfiles.push(buildTenantProfile(accountEntity.homeAccountId, accountEntity.localAccountId, accountEntity.realm));
			return {
				homeAccountId: accountEntity.homeAccountId,
				environment: accountEntity.environment,
				tenantId: accountEntity.realm,
				username: accountEntity.username,
				localAccountId: accountEntity.localAccountId,
				loginHint: accountEntity.loginHint,
				name: accountEntity.name,
				nativeAccountId: accountEntity.nativeAccountId,
				authorityType: accountEntity.authorityType,
				tenantProfiles: new Map(tenantProfiles.map((tenantProfile) => {
					return [tenantProfile.tenantId, tenantProfile];
				})),
				dataBoundary: accountEntity.dataBoundary
			};
		}
		/**
		* Returns true if the account entity is in single tenant format (outdated), false otherwise
		*/
		isSingleTenant() {
			return !this.tenantProfiles;
		}
		/**
		* Build Account cache from IdToken, clientInfo and authority/policy. Associated with AAD.
		* @param accountDetails
		*/
		static createAccount(accountDetails, authority, base64Decode) {
			const account = new AccountEntity();
			if (authority.authorityType === AuthorityType.Adfs) account.authorityType = CacheAccountType.ADFS_ACCOUNT_TYPE;
			else if (authority.protocolMode === ProtocolMode.OIDC) account.authorityType = CacheAccountType.GENERIC_ACCOUNT_TYPE;
			else account.authorityType = CacheAccountType.MSSTS_ACCOUNT_TYPE;
			let clientInfo;
			if (accountDetails.clientInfo && base64Decode) {
				clientInfo = buildClientInfo(accountDetails.clientInfo, base64Decode);
				if (clientInfo.xms_tdbr) account.dataBoundary = clientInfo.xms_tdbr === "EU" ? "EU" : "None";
			}
			account.clientInfo = accountDetails.clientInfo;
			account.homeAccountId = accountDetails.homeAccountId;
			account.nativeAccountId = accountDetails.nativeAccountId;
			const env = accountDetails.environment || authority && authority.getPreferredCache();
			if (!env) throw createClientAuthError(invalidCacheEnvironment);
			account.environment = env;
			account.realm = clientInfo?.utid || getTenantIdFromIdTokenClaims(accountDetails.idTokenClaims) || "";
			account.localAccountId = clientInfo?.uid || accountDetails.idTokenClaims?.oid || accountDetails.idTokenClaims?.sub || "";
			const preferredUsername = accountDetails.idTokenClaims?.preferred_username || accountDetails.idTokenClaims?.upn;
			const email = accountDetails.idTokenClaims?.emails ? accountDetails.idTokenClaims.emails[0] : null;
			account.username = preferredUsername || email || "";
			account.loginHint = accountDetails.idTokenClaims?.login_hint;
			account.name = accountDetails.idTokenClaims?.name || "";
			account.cloudGraphHostName = accountDetails.cloudGraphHostName;
			account.msGraphHost = accountDetails.msGraphHost;
			if (accountDetails.tenantProfiles) account.tenantProfiles = accountDetails.tenantProfiles;
			else account.tenantProfiles = [buildTenantProfile(accountDetails.homeAccountId, account.localAccountId, account.realm, accountDetails.idTokenClaims)];
			return account;
		}
		/**
		* Creates an AccountEntity object from AccountInfo
		* @param accountInfo
		* @param cloudGraphHostName
		* @param msGraphHost
		* @returns
		*/
		static createFromAccountInfo(accountInfo, cloudGraphHostName, msGraphHost) {
			const account = new AccountEntity();
			account.authorityType = accountInfo.authorityType || CacheAccountType.GENERIC_ACCOUNT_TYPE;
			account.homeAccountId = accountInfo.homeAccountId;
			account.localAccountId = accountInfo.localAccountId;
			account.nativeAccountId = accountInfo.nativeAccountId;
			account.realm = accountInfo.tenantId;
			account.environment = accountInfo.environment;
			account.username = accountInfo.username;
			account.name = accountInfo.name;
			account.loginHint = accountInfo.loginHint;
			account.cloudGraphHostName = cloudGraphHostName;
			account.msGraphHost = msGraphHost;
			const tenantProfiles = Array.from(accountInfo.tenantProfiles?.values() || []);
			if (tenantProfiles.length === 0 && accountInfo.tenantId && accountInfo.localAccountId) tenantProfiles.push(buildTenantProfile(accountInfo.homeAccountId, accountInfo.localAccountId, accountInfo.tenantId, accountInfo.idTokenClaims));
			account.tenantProfiles = tenantProfiles;
			account.dataBoundary = accountInfo.dataBoundary;
			return account;
		}
		/**
		* Generate HomeAccountId from server response
		* @param serverClientInfo
		* @param authType
		*/
		static generateHomeAccountId(serverClientInfo, authType, logger, cryptoObj, idTokenClaims) {
			if (!(authType === AuthorityType.Adfs || authType === AuthorityType.Dsts)) {
				if (serverClientInfo) try {
					const clientInfo = buildClientInfo(serverClientInfo, cryptoObj.base64Decode);
					if (clientInfo.uid && clientInfo.utid) return `${clientInfo.uid}.${clientInfo.utid}`;
				} catch (e) {}
				logger.warning("No client info in response");
			}
			return idTokenClaims?.sub || "";
		}
		/**
		* Validates an entity: checks for all expected params
		* @param entity
		*/
		static isAccountEntity(entity) {
			if (!entity) return false;
			return entity.hasOwnProperty("homeAccountId") && entity.hasOwnProperty("environment") && entity.hasOwnProperty("realm") && entity.hasOwnProperty("localAccountId") && entity.hasOwnProperty("username") && entity.hasOwnProperty("authorityType");
		}
		/**
		* Helper function to determine whether 2 accountInfo objects represent the same account
		* @param accountA
		* @param accountB
		* @param compareClaims - If set to true idTokenClaims will also be compared to determine account equality
		*/
		static accountInfoIsEqual(accountA, accountB, compareClaims) {
			if (!accountA || !accountB) return false;
			let claimsMatch = true;
			if (compareClaims) {
				const accountAClaims = accountA.idTokenClaims || {};
				const accountBClaims = accountB.idTokenClaims || {};
				claimsMatch = accountAClaims.iat === accountBClaims.iat && accountAClaims.nonce === accountBClaims.nonce;
			}
			return accountA.homeAccountId === accountB.homeAccountId && accountA.localAccountId === accountB.localAccountId && accountA.username === accountB.username && accountA.tenantId === accountB.tenantId && accountA.loginHint === accountB.loginHint && accountA.environment === accountB.environment && accountA.nativeAccountId === accountB.nativeAccountId && claimsMatch;
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Extract token by decoding the rawToken
	*
	* @param encodedToken
	*/
	function extractTokenClaims(encodedToken, base64Decode) {
		const jswPayload = getJWSPayload(encodedToken);
		try {
			const base64Decoded = base64Decode(jswPayload);
			return JSON.parse(base64Decoded);
		} catch (err) {
			throw createClientAuthError(tokenParsingError);
		}
	}
	/**
	* Check if the signin_state claim contains "kmsi"
	* @param idTokenClaims
	* @returns
	*/
	function isKmsi(idTokenClaims) {
		if (!idTokenClaims.signin_state) return false;
		/**
		* Signin_state claim known values:
		* dvc_mngd - device is managed
		* dvc_dmjd - device is domain joined
		* kmsi - user opted to "keep me signed in"
		* inknownntwk - Request made inside a known network. Don't use this, use CAE instead.
		*/
		const kmsiClaims = ["kmsi", "dvc_dmjd"];
		return idTokenClaims.signin_state.some((value) => kmsiClaims.includes(value.trim().toLowerCase()));
	}
	/**
	* decode a JWT
	*
	* @param authToken
	*/
	function getJWSPayload(authToken) {
		if (!authToken) throw createClientAuthError(nullOrEmptyToken);
		const matches = /^([^\.\s]*)\.([^\.\s]+)\.([^\.\s]*)$/.exec(authToken);
		if (!matches || matches.length < 4) throw createClientAuthError(tokenParsingError);
		/**
		* const crackedToken = {
		*  header: matches[1],
		*  JWSPayload: matches[2],
		*  JWSSig: matches[3],
		* };
		*/
		return matches[2];
	}
	/**
	* Determine if the token's max_age has transpired
	*/
	function checkMaxAge(authTime, maxAge) {
		if (maxAge === 0 || Date.now() - 3e5 > authTime + maxAge) throw createClientAuthError(maxAgeTranspired);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Parses hash string from given string. Returns empty string if no hash symbol is found.
	* @param hashString
	*/
	function stripLeadingHashOrQuery(responseString) {
		if (responseString.startsWith("#/")) return responseString.substring(2);
		else if (responseString.startsWith("#") || responseString.startsWith("?")) return responseString.substring(1);
		return responseString;
	}
	/**
	* Returns URL hash as server auth code response object.
	*/
	function getDeserializedResponse(responseString) {
		if (!responseString || responseString.indexOf("=") < 0) return null;
		try {
			const normalizedResponse = stripLeadingHashOrQuery(responseString);
			const deserializedHash = Object.fromEntries(new URLSearchParams(normalizedResponse));
			if (deserializedHash.code || deserializedHash.ear_jwe || deserializedHash.error || deserializedHash.error_description || deserializedHash.state) return deserializedHash;
		} catch (e) {
			throw createClientAuthError(hashNotDeserialized);
		}
		return null;
	}
	/**
	* Utility to create a URL from the params map
	*/
	function mapToQueryString(parameters, encodeExtraParams = true, extraQueryParameters) {
		const queryParameterArray = new Array();
		parameters.forEach((value, key) => {
			if (!encodeExtraParams && extraQueryParameters && key in extraQueryParameters) queryParameterArray.push(`${key}=${value}`);
			else queryParameterArray.push(`${key}=${encodeURIComponent(value)}`);
		});
		return queryParameterArray.join("&");
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Url object class which can perform various transformations on url strings.
	*/
	var UrlString = class UrlString {
		get urlString() {
			return this._urlString;
		}
		constructor(url) {
			this._urlString = url;
			if (!this._urlString) throw createClientConfigurationError(urlEmptyError);
			if (!url.includes("#")) this._urlString = UrlString.canonicalizeUri(url);
		}
		/**
		* Ensure urls are lower case and end with a / character.
		* @param url
		*/
		static canonicalizeUri(url) {
			if (url) {
				let lowerCaseUrl = url.toLowerCase();
				if (StringUtils.endsWith(lowerCaseUrl, "?")) lowerCaseUrl = lowerCaseUrl.slice(0, -1);
				else if (StringUtils.endsWith(lowerCaseUrl, "?/")) lowerCaseUrl = lowerCaseUrl.slice(0, -2);
				if (!StringUtils.endsWith(lowerCaseUrl, "/")) lowerCaseUrl += "/";
				return lowerCaseUrl;
			}
			return url;
		}
		/**
		* Throws if urlString passed is not a valid authority URI string.
		*/
		validateAsUri() {
			let components;
			try {
				components = this.getUrlComponents();
			} catch (e) {
				throw createClientConfigurationError(urlParseError);
			}
			if (!components.HostNameAndPort || !components.PathSegments) throw createClientConfigurationError(urlParseError);
			if (!components.Protocol || components.Protocol.toLowerCase() !== "https:") throw createClientConfigurationError(authorityUriInsecure);
		}
		/**
		* Given a url and a query string return the url with provided query string appended
		* @param url
		* @param queryString
		*/
		static appendQueryString(url, queryString) {
			if (!queryString) return url;
			return url.indexOf("?") < 0 ? `${url}?${queryString}` : `${url}&${queryString}`;
		}
		/**
		* Returns a url with the hash removed
		* @param url
		*/
		static removeHashFromUrl(url) {
			return UrlString.canonicalizeUri(url.split("#")[0]);
		}
		/**
		* Given a url like https://a:b/common/d?e=f#g, and a tenantId, returns https://a:b/tenantId/d
		* @param href The url
		* @param tenantId The tenant id to replace
		*/
		replaceTenantPath(tenantId) {
			const urlObject = this.getUrlComponents();
			const pathArray = urlObject.PathSegments;
			if (tenantId && pathArray.length !== 0 && (pathArray[0] === AADAuthorityConstants.COMMON || pathArray[0] === AADAuthorityConstants.ORGANIZATIONS)) pathArray[0] = tenantId;
			return UrlString.constructAuthorityUriFromObject(urlObject);
		}
		/**
		* Parses out the components from a url string.
		* @returns An object with the various components. Please cache this value insted of calling this multiple times on the same url.
		*/
		getUrlComponents() {
			const regEx = RegExp("^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?");
			const match = this.urlString.match(regEx);
			if (!match) throw createClientConfigurationError(urlParseError);
			const urlComponents = {
				Protocol: match[1],
				HostNameAndPort: match[4],
				AbsolutePath: match[5],
				QueryString: match[7]
			};
			let pathSegments = urlComponents.AbsolutePath.split("/");
			pathSegments = pathSegments.filter((val) => val && val.length > 0);
			urlComponents.PathSegments = pathSegments;
			if (urlComponents.QueryString && urlComponents.QueryString.endsWith("/")) urlComponents.QueryString = urlComponents.QueryString.substring(0, urlComponents.QueryString.length - 1);
			return urlComponents;
		}
		static getDomainFromUrl(url) {
			const regEx = RegExp("^([^:/?#]+://)?([^/?#]*)");
			const match = url.match(regEx);
			if (!match) throw createClientConfigurationError(urlParseError);
			return match[2];
		}
		static getAbsoluteUrl(relativeUrl, baseUrl) {
			if (relativeUrl[0] === Constants$1.FORWARD_SLASH) {
				const baseComponents = new UrlString(baseUrl).getUrlComponents();
				return baseComponents.Protocol + "//" + baseComponents.HostNameAndPort + relativeUrl;
			}
			return relativeUrl;
		}
		static constructAuthorityUriFromObject(urlObject) {
			return new UrlString(urlObject.Protocol + "//" + urlObject.HostNameAndPort + "/" + urlObject.PathSegments.join("/"));
		}
		/**
		* Check if the hash of the URL string contains known properties
		* @deprecated This API will be removed in a future version
		*/
		static hashContainsKnownProperties(response) {
			return !!getDeserializedResponse(response);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const rawMetdataJSON = {
		endpointMetadata: {
			"login.microsoftonline.com": {
				token_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.microsoftonline.com/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
				authorization_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.microsoftonline.com/{tenantid}/oauth2/v2.0/logout"
			},
			"login.chinacloudapi.cn": {
				token_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.chinacloudapi.cn/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.partner.microsoftonline.cn/{tenantid}/v2.0",
				authorization_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.chinacloudapi.cn/{tenantid}/oauth2/v2.0/logout"
			},
			"login.microsoftonline.us": {
				token_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.microsoftonline.us/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.microsoftonline.us/{tenantid}/v2.0",
				authorization_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.microsoftonline.us/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.fr": {
				token_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.fr/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.fr/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.fr/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.de": {
				token_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.de/{tenantid}/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.de/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.de/{tenantid}/oauth2/v2.0/logout"
			},
			"login.sovcloud-identity.sg": {
				token_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/token",
				jwks_uri: "https://login.sovcloud-identity.sg/common/discovery/v2.0/keys",
				issuer: "https://login.sovcloud-identity.sg/{tenantid}/v2.0",
				authorization_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/authorize",
				end_session_endpoint: "https://login.sovcloud-identity.sg/common/oauth2/v2.0/logout"
			}
		},
		instanceDiscoveryMetadata: { metadata: [
			{
				preferred_network: "login.microsoftonline.com",
				preferred_cache: "login.windows.net",
				aliases: [
					"login.microsoftonline.com",
					"login.windows.net",
					"login.microsoft.com",
					"sts.windows.net"
				]
			},
			{
				preferred_network: "login.partner.microsoftonline.cn",
				preferred_cache: "login.partner.microsoftonline.cn",
				aliases: ["login.partner.microsoftonline.cn", "login.chinacloudapi.cn"]
			},
			{
				preferred_network: "login.microsoftonline.de",
				preferred_cache: "login.microsoftonline.de",
				aliases: ["login.microsoftonline.de"]
			},
			{
				preferred_network: "login.microsoftonline.us",
				preferred_cache: "login.microsoftonline.us",
				aliases: ["login.microsoftonline.us", "login.usgovcloudapi.net"]
			},
			{
				preferred_network: "login-us.microsoftonline.com",
				preferred_cache: "login-us.microsoftonline.com",
				aliases: ["login-us.microsoftonline.com"]
			},
			{
				preferred_network: "login.sovcloud-identity.fr",
				preferred_cache: "login.sovcloud-identity.fr",
				aliases: ["login.sovcloud-identity.fr"]
			},
			{
				preferred_network: "login.sovcloud-identity.de",
				preferred_cache: "login.sovcloud-identity.de",
				aliases: ["login.sovcloud-identity.de"]
			},
			{
				preferred_network: "login.sovcloud-identity.sg",
				preferred_cache: "login.sovcloud-identity.sg",
				aliases: ["login.sovcloud-identity.sg"]
			}
		] }
	};
	const EndpointMetadata = rawMetdataJSON.endpointMetadata;
	const InstanceDiscoveryMetadata = rawMetdataJSON.instanceDiscoveryMetadata;
	const InstanceDiscoveryMetadataAliases = /* @__PURE__ */ new Set();
	InstanceDiscoveryMetadata.metadata.forEach((metadataEntry) => {
		metadataEntry.aliases.forEach((alias) => {
			InstanceDiscoveryMetadataAliases.add(alias);
		});
	});
	/**
	* Attempts to get an aliases array from the static authority metadata sources based on the canonical authority host
	* @param staticAuthorityOptions
	* @param logger
	* @returns
	*/
	function getAliasesFromStaticSources(staticAuthorityOptions, logger) {
		let staticAliases;
		const canonicalAuthority = staticAuthorityOptions.canonicalAuthority;
		if (canonicalAuthority) {
			const authorityHost = new UrlString(canonicalAuthority).getUrlComponents().HostNameAndPort;
			staticAliases = getAliasesFromMetadata(authorityHost, staticAuthorityOptions.cloudDiscoveryMetadata?.metadata, AuthorityMetadataSource.CONFIG, logger) || getAliasesFromMetadata(authorityHost, InstanceDiscoveryMetadata.metadata, AuthorityMetadataSource.HARDCODED_VALUES, logger) || staticAuthorityOptions.knownAuthorities;
		}
		return staticAliases || [];
	}
	/**
	* Returns aliases for from the raw cloud discovery metadata passed in
	* @param authorityHost
	* @param rawCloudDiscoveryMetadata
	* @returns
	*/
	function getAliasesFromMetadata(authorityHost, cloudDiscoveryMetadata, source, logger) {
		logger?.trace(`getAliasesFromMetadata called with source: ${source}`);
		if (authorityHost && cloudDiscoveryMetadata) {
			const metadata = getCloudDiscoveryMetadataFromNetworkResponse(cloudDiscoveryMetadata, authorityHost);
			if (metadata) {
				logger?.trace(`getAliasesFromMetadata: found cloud discovery metadata in ${source}, returning aliases`);
				return metadata.aliases;
			} else logger?.trace(`getAliasesFromMetadata: did not find cloud discovery metadata in ${source}`);
		}
		return null;
	}
	/**
	* Get cloud discovery metadata for common authorities
	*/
	function getCloudDiscoveryMetadataFromHardcodedValues(authorityHost) {
		return getCloudDiscoveryMetadataFromNetworkResponse(InstanceDiscoveryMetadata.metadata, authorityHost);
	}
	/**
	* Searches instance discovery network response for the entry that contains the host in the aliases list
	* @param response
	* @param authority
	*/
	function getCloudDiscoveryMetadataFromNetworkResponse(response, authorityHost) {
		for (let i = 0; i < response.length; i++) {
			const metadata = response[i];
			if (metadata.aliases.includes(authorityHost)) return metadata;
		}
		return null;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const cacheQuotaExceeded = "cache_quota_exceeded";
	const cacheErrorUnknown = "cache_error_unknown";
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const CacheErrorMessages = {
		[cacheQuotaExceeded]: "Exceeded cache storage capacity.",
		[cacheErrorUnknown]: "Unexpected error occurred when using cache storage."
	};
	/**
	* Error thrown when there is an error with the cache
	*/
	var CacheError = class CacheError extends AuthError {
		constructor(errorCode, errorMessage) {
			const message = errorMessage || (CacheErrorMessages[errorCode] ? CacheErrorMessages[errorCode] : CacheErrorMessages[cacheErrorUnknown]);
			super(`${errorCode}: ${message}`);
			Object.setPrototypeOf(this, CacheError.prototype);
			this.name = "CacheError";
			this.errorCode = errorCode;
			this.errorMessage = message;
		}
	};
	/**
	* Helper function to wrap browser errors in a CacheError object
	* @param e
	* @returns
	*/
	function createCacheError(e) {
		if (!(e instanceof Error)) return new CacheError(cacheErrorUnknown);
		if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.message.includes("exceeded the quota")) return new CacheError(cacheQuotaExceeded);
		else return new CacheError(e.name, e.message);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Interface class which implement cache storage functions used by MSAL to perform validity checks, and store tokens.
	* @internal
	*/
	var CacheManager = class {
		constructor(clientId, cryptoImpl, logger, performanceClient, staticAuthorityOptions) {
			this.clientId = clientId;
			this.cryptoImpl = cryptoImpl;
			this.commonLogger = logger.clone(name$1, version$1);
			this.staticAuthorityOptions = staticAuthorityOptions;
			this.performanceClient = performanceClient;
		}
		/**
		* Returns all the accounts in the cache that match the optional filter. If no filter is provided, all accounts are returned.
		* @param accountFilter - (Optional) filter to narrow down the accounts returned
		* @returns Array of AccountInfo objects in cache
		*/
		getAllAccounts(accountFilter, correlationId) {
			return this.buildTenantProfiles(this.getAccountsFilteredBy(accountFilter, correlationId), correlationId, accountFilter);
		}
		/**
		* Gets first tenanted AccountInfo object found based on provided filters
		*/
		getAccountInfoFilteredBy(accountFilter, correlationId) {
			if (Object.keys(accountFilter).length === 0 || Object.values(accountFilter).every((value) => !value)) {
				this.commonLogger.warning("getAccountInfoFilteredBy: Account filter is empty or invalid, returning null");
				return null;
			}
			const allAccounts = this.getAllAccounts(accountFilter, correlationId);
			if (allAccounts.length > 1) return allAccounts.sort((account) => {
				return account.idTokenClaims ? -1 : 1;
			})[0];
			else if (allAccounts.length === 1) return allAccounts[0];
			else return null;
		}
		/**
		* Returns a single matching
		* @param accountFilter
		* @returns
		*/
		getBaseAccountInfo(accountFilter, correlationId) {
			const accountEntities = this.getAccountsFilteredBy(accountFilter, correlationId);
			if (accountEntities.length > 0) return AccountEntity.getAccountInfo(accountEntities[0]);
			else return null;
		}
		/**
		* Matches filtered account entities with cached ID tokens that match the tenant profile-specific account filters
		* and builds the account info objects from the matching ID token's claims
		* @param cachedAccounts
		* @param accountFilter
		* @returns Array of AccountInfo objects that match account and tenant profile filters
		*/
		buildTenantProfiles(cachedAccounts, correlationId, accountFilter) {
			return cachedAccounts.flatMap((accountEntity) => {
				return this.getTenantProfilesFromAccountEntity(accountEntity, correlationId, accountFilter?.tenantId, accountFilter);
			});
		}
		getTenantedAccountInfoByFilter(accountInfo, tokenKeys, tenantProfile, correlationId, tenantProfileFilter) {
			let tenantedAccountInfo = null;
			let idTokenClaims;
			if (tenantProfileFilter) {
				if (!this.tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter)) return null;
			}
			const idToken = this.getIdToken(accountInfo, correlationId, tokenKeys, tenantProfile.tenantId);
			if (idToken) {
				idTokenClaims = extractTokenClaims(idToken.secret, this.cryptoImpl.base64Decode);
				if (!this.idTokenClaimsMatchTenantProfileFilter(idTokenClaims, tenantProfileFilter)) return null;
			}
			tenantedAccountInfo = updateAccountTenantProfileData(accountInfo, tenantProfile, idTokenClaims, idToken?.secret);
			return tenantedAccountInfo;
		}
		getTenantProfilesFromAccountEntity(accountEntity, correlationId, targetTenantId, tenantProfileFilter) {
			const accountInfo = AccountEntity.getAccountInfo(accountEntity);
			let searchTenantProfiles = accountInfo.tenantProfiles || /* @__PURE__ */ new Map();
			const tokenKeys = this.getTokenKeys();
			if (targetTenantId) {
				const tenantProfile = searchTenantProfiles.get(targetTenantId);
				if (tenantProfile) searchTenantProfiles = new Map([[targetTenantId, tenantProfile]]);
				else return [];
			}
			const matchingTenantProfiles = [];
			searchTenantProfiles.forEach((tenantProfile) => {
				const tenantedAccountInfo = this.getTenantedAccountInfoByFilter(accountInfo, tokenKeys, tenantProfile, correlationId, tenantProfileFilter);
				if (tenantedAccountInfo) matchingTenantProfiles.push(tenantedAccountInfo);
			});
			return matchingTenantProfiles;
		}
		tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter) {
			if (!!tenantProfileFilter.localAccountId && !this.matchLocalAccountIdFromTenantProfile(tenantProfile, tenantProfileFilter.localAccountId)) return false;
			if (!!tenantProfileFilter.name && !(tenantProfile.name === tenantProfileFilter.name)) return false;
			if (tenantProfileFilter.isHomeTenant !== void 0 && !(tenantProfile.isHomeTenant === tenantProfileFilter.isHomeTenant)) return false;
			return true;
		}
		idTokenClaimsMatchTenantProfileFilter(idTokenClaims, tenantProfileFilter) {
			if (tenantProfileFilter) {
				if (!!tenantProfileFilter.localAccountId && !this.matchLocalAccountIdFromTokenClaims(idTokenClaims, tenantProfileFilter.localAccountId)) return false;
				if (!!tenantProfileFilter.loginHint && !this.matchLoginHintFromTokenClaims(idTokenClaims, tenantProfileFilter.loginHint)) return false;
				if (!!tenantProfileFilter.username && !this.matchUsername(idTokenClaims.preferred_username, tenantProfileFilter.username)) return false;
				if (!!tenantProfileFilter.name && !this.matchName(idTokenClaims, tenantProfileFilter.name)) return false;
				if (!!tenantProfileFilter.sid && !this.matchSid(idTokenClaims, tenantProfileFilter.sid)) return false;
			}
			return true;
		}
		/**
		* saves a cache record
		* @param cacheRecord {CacheRecord}
		* @param correlationId {?string} correlation id
		* @param kmsi - Keep Me Signed In
		* @param apiId - API identifier for telemetry tracking
		* @param storeInCache {?StoreInCache}
		*/
		async saveCacheRecord(cacheRecord, correlationId, kmsi, apiId, storeInCache) {
			if (!cacheRecord) throw createClientAuthError(invalidCacheRecord);
			try {
				if (!!cacheRecord.account) await this.setAccount(cacheRecord.account, correlationId, kmsi, apiId);
				if (!!cacheRecord.idToken && storeInCache?.idToken !== false) await this.setIdTokenCredential(cacheRecord.idToken, correlationId, kmsi);
				if (!!cacheRecord.accessToken && storeInCache?.accessToken !== false) await this.saveAccessToken(cacheRecord.accessToken, correlationId, kmsi);
				if (!!cacheRecord.refreshToken && storeInCache?.refreshToken !== false) await this.setRefreshTokenCredential(cacheRecord.refreshToken, correlationId, kmsi);
				if (!!cacheRecord.appMetadata) this.setAppMetadata(cacheRecord.appMetadata, correlationId);
			} catch (e) {
				this.commonLogger?.error(`CacheManager.saveCacheRecord: failed`);
				if (e instanceof AuthError) throw e;
				else throw createCacheError(e);
			}
		}
		/**
		* saves access token credential
		* @param credential
		*/
		async saveAccessToken(credential, correlationId, kmsi) {
			const accessTokenFilter = {
				clientId: credential.clientId,
				credentialType: credential.credentialType,
				environment: credential.environment,
				homeAccountId: credential.homeAccountId,
				realm: credential.realm,
				tokenType: credential.tokenType,
				requestedClaimsHash: credential.requestedClaimsHash
			};
			const tokenKeys = this.getTokenKeys();
			const currentScopes = ScopeSet.fromString(credential.target);
			tokenKeys.accessToken.forEach((key) => {
				if (!this.accessTokenKeyMatchesFilter(key, accessTokenFilter, false)) return;
				const tokenEntity = this.getAccessTokenCredential(key, correlationId);
				if (tokenEntity && this.credentialMatchesFilter(tokenEntity, accessTokenFilter)) {
					if (ScopeSet.fromString(tokenEntity.target).intersectingScopeSets(currentScopes)) this.removeAccessToken(key, correlationId);
				}
			});
			await this.setAccessTokenCredential(credential, correlationId, kmsi);
		}
		/**
		* Retrieve account entities matching all provided tenant-agnostic filters; if no filter is set, get all account entities in the cache
		* Not checking for casing as keys are all generated in lower case, remember to convert to lower case if object properties are compared
		* @param accountFilter - An object containing Account properties to filter by
		*/
		getAccountsFilteredBy(accountFilter, correlationId) {
			const allAccountKeys = this.getAccountKeys();
			const matchingAccounts = [];
			allAccountKeys.forEach((cacheKey) => {
				const entity = this.getAccount(cacheKey, correlationId);
				if (!entity) return;
				if (!!accountFilter.homeAccountId && !this.matchHomeAccountId(entity, accountFilter.homeAccountId)) return;
				if (!!accountFilter.username && !this.matchUsername(entity.username, accountFilter.username)) return;
				if (!!accountFilter.environment && !this.matchEnvironment(entity, accountFilter.environment)) return;
				if (!!accountFilter.realm && !this.matchRealm(entity, accountFilter.realm)) return;
				if (!!accountFilter.nativeAccountId && !this.matchNativeAccountId(entity, accountFilter.nativeAccountId)) return;
				if (!!accountFilter.authorityType && !this.matchAuthorityType(entity, accountFilter.authorityType)) return;
				const tenantProfileFilter = {
					localAccountId: accountFilter?.localAccountId,
					name: accountFilter?.name
				};
				const matchingTenantProfiles = entity.tenantProfiles?.filter((tenantProfile) => {
					return this.tenantProfileMatchesFilter(tenantProfile, tenantProfileFilter);
				});
				if (matchingTenantProfiles && matchingTenantProfiles.length === 0) return;
				matchingAccounts.push(entity);
			});
			return matchingAccounts;
		}
		/**
		* Returns whether or not the given credential entity matches the filter
		* @param entity
		* @param filter
		* @returns
		*/
		credentialMatchesFilter(entity, filter) {
			if (!!filter.clientId && !this.matchClientId(entity, filter.clientId)) return false;
			if (!!filter.userAssertionHash && !this.matchUserAssertionHash(entity, filter.userAssertionHash)) return false;
			if (typeof filter.homeAccountId === "string" && !this.matchHomeAccountId(entity, filter.homeAccountId)) return false;
			if (!!filter.environment && !this.matchEnvironment(entity, filter.environment)) return false;
			if (!!filter.realm && !this.matchRealm(entity, filter.realm)) return false;
			if (!!filter.credentialType && !this.matchCredentialType(entity, filter.credentialType)) return false;
			if (!!filter.familyId && !this.matchFamilyId(entity, filter.familyId)) return false;
			if (!!filter.target && !this.matchTarget(entity, filter.target)) return false;
			if (filter.requestedClaimsHash || entity.requestedClaimsHash) {
				if (entity.requestedClaimsHash !== filter.requestedClaimsHash) return false;
			}
			if (entity.credentialType === CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME) {
				if (!!filter.tokenType && !this.matchTokenType(entity, filter.tokenType)) return false;
				if (filter.tokenType === AuthenticationScheme.SSH) {
					if (filter.keyId && !this.matchKeyId(entity, filter.keyId)) return false;
				}
			}
			return true;
		}
		/**
		* retrieve appMetadata matching all provided filters; if no filter is set, get all appMetadata
		* @param filter
		*/
		getAppMetadataFilteredBy(filter) {
			const allCacheKeys = this.getKeys();
			const matchingAppMetadata = {};
			allCacheKeys.forEach((cacheKey) => {
				if (!this.isAppMetadata(cacheKey)) return;
				const entity = this.getAppMetadata(cacheKey);
				if (!entity) return;
				if (!!filter.environment && !this.matchEnvironment(entity, filter.environment)) return;
				if (!!filter.clientId && !this.matchClientId(entity, filter.clientId)) return;
				matchingAppMetadata[cacheKey] = entity;
			});
			return matchingAppMetadata;
		}
		/**
		* retrieve authorityMetadata that contains a matching alias
		* @param filter
		*/
		getAuthorityMetadataByAlias(host) {
			const allCacheKeys = this.getAuthorityMetadataKeys();
			let matchedEntity = null;
			allCacheKeys.forEach((cacheKey) => {
				if (!this.isAuthorityMetadata(cacheKey) || cacheKey.indexOf(this.clientId) === -1) return;
				const entity = this.getAuthorityMetadata(cacheKey);
				if (!entity) return;
				if (entity.aliases.indexOf(host) === -1) return;
				matchedEntity = entity;
			});
			return matchedEntity;
		}
		/**
		* Removes all accounts and related tokens from cache.
		*/
		removeAllAccounts(correlationId) {
			this.getAllAccounts({}, correlationId).forEach((account) => {
				this.removeAccount(account, correlationId);
			});
		}
		/**
		* Removes the account and related tokens for a given account key
		* @param account
		*/
		removeAccount(account, correlationId) {
			this.removeAccountContext(account, correlationId);
			const accountKeys = this.getAccountKeys();
			const keyFilter = (key) => {
				return key.includes(account.homeAccountId) && key.includes(account.environment);
			};
			accountKeys.filter(keyFilter).forEach((key) => {
				this.removeItem(key, correlationId);
				this.performanceClient.incrementFields({ accountsRemoved: 1 }, correlationId);
			});
		}
		/**
		* Removes credentials associated with the provided account
		* @param account
		*/
		removeAccountContext(account, correlationId) {
			const allTokenKeys = this.getTokenKeys();
			const keyFilter = (key) => {
				return key.includes(account.homeAccountId) && key.includes(account.environment);
			};
			allTokenKeys.idToken.filter(keyFilter).forEach((key) => {
				this.removeIdToken(key, correlationId);
			});
			allTokenKeys.accessToken.filter(keyFilter).forEach((key) => {
				this.removeAccessToken(key, correlationId);
			});
			allTokenKeys.refreshToken.filter(keyFilter).forEach((key) => {
				this.removeRefreshToken(key, correlationId);
			});
		}
		/**
		* Removes accessToken from the cache
		* @param key
		* @param correlationId
		*/
		removeAccessToken(key, correlationId) {
			const credential = this.getAccessTokenCredential(key, correlationId);
			this.removeItem(key, correlationId);
			this.performanceClient.incrementFields({ accessTokensRemoved: 1 }, correlationId);
			if (!credential || credential.credentialType.toLowerCase() !== CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME.toLowerCase() || credential.tokenType !== AuthenticationScheme.POP) return;
			const kid = credential.keyId;
			if (kid) this.cryptoImpl.removeTokenBindingKey(kid).catch(() => {
				this.commonLogger.error(`Failed to remove token binding key ${kid}`, correlationId);
				this.performanceClient?.incrementFields({ removeTokenBindingKeyFailure: 1 }, correlationId);
			});
		}
		/**
		* Removes all app metadata objects from cache.
		*/
		removeAppMetadata(correlationId) {
			this.getKeys().forEach((cacheKey) => {
				if (this.isAppMetadata(cacheKey)) this.removeItem(cacheKey, correlationId);
			});
			return true;
		}
		/**
		* Retrieve IdTokenEntity from cache
		* @param account {AccountInfo}
		* @param tokenKeys {?TokenKeys}
		* @param targetRealm {?string}
		* @param performanceClient {?IPerformanceClient}
		* @param correlationId {?string}
		*/
		getIdToken(account, correlationId, tokenKeys, targetRealm, performanceClient) {
			this.commonLogger.trace("CacheManager - getIdToken called");
			const idTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType: CredentialType.ID_TOKEN,
				clientId: this.clientId,
				realm: targetRealm
			};
			const idTokenMap = this.getIdTokensByFilter(idTokenFilter, correlationId, tokenKeys);
			const numIdTokens = idTokenMap.size;
			if (numIdTokens < 1) {
				this.commonLogger.info("CacheManager:getIdToken - No token found");
				return null;
			} else if (numIdTokens > 1) {
				let tokensToBeRemoved = idTokenMap;
				if (!targetRealm) {
					const homeIdTokenMap = /* @__PURE__ */ new Map();
					idTokenMap.forEach((idToken, key) => {
						if (idToken.realm === account.tenantId) homeIdTokenMap.set(key, idToken);
					});
					const numHomeIdTokens = homeIdTokenMap.size;
					if (numHomeIdTokens < 1) {
						this.commonLogger.info("CacheManager:getIdToken - Multiple ID tokens found for account but none match account entity tenant id, returning first result");
						return idTokenMap.values().next().value;
					} else if (numHomeIdTokens === 1) {
						this.commonLogger.info("CacheManager:getIdToken - Multiple ID tokens found for account, defaulting to home tenant profile");
						return homeIdTokenMap.values().next().value;
					} else tokensToBeRemoved = homeIdTokenMap;
				}
				this.commonLogger.info("CacheManager:getIdToken - Multiple matching ID tokens found, clearing them");
				tokensToBeRemoved.forEach((idToken, key) => {
					this.removeIdToken(key, correlationId);
				});
				if (performanceClient && correlationId) performanceClient.addFields({ multiMatchedID: idTokenMap.size }, correlationId);
				return null;
			}
			this.commonLogger.info("CacheManager:getIdToken - Returning ID token");
			return idTokenMap.values().next().value;
		}
		/**
		* Gets all idTokens matching the given filter
		* @param filter
		* @returns
		*/
		getIdTokensByFilter(filter, correlationId, tokenKeys) {
			const idTokenKeys = tokenKeys && tokenKeys.idToken || this.getTokenKeys().idToken;
			const idTokens = /* @__PURE__ */ new Map();
			idTokenKeys.forEach((key) => {
				if (!this.idTokenKeyMatchesFilter(key, {
					clientId: this.clientId,
					...filter
				})) return;
				const idToken = this.getIdTokenCredential(key, correlationId);
				if (idToken && this.credentialMatchesFilter(idToken, filter)) idTokens.set(key, idToken);
			});
			return idTokens;
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		* @returns
		*/
		idTokenKeyMatchesFilter(inputKey, filter) {
			const key = inputKey.toLowerCase();
			if (filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			return true;
		}
		/**
		* Removes idToken from the cache
		* @param key
		*/
		removeIdToken(key, correlationId) {
			this.removeItem(key, correlationId);
		}
		/**
		* Removes refresh token from the cache
		* @param key
		*/
		removeRefreshToken(key, correlationId) {
			this.removeItem(key, correlationId);
		}
		/**
		* Retrieve AccessTokenEntity from cache
		* @param account {AccountInfo}
		* @param request {BaseAuthRequest}
		* @param correlationId {?string}
		* @param tokenKeys {?TokenKeys}
		* @param performanceClient {?IPerformanceClient}
		*/
		getAccessToken(account, request, tokenKeys, targetRealm) {
			const correlationId = request.correlationId;
			this.commonLogger.trace("CacheManager - getAccessToken called", correlationId);
			const scopes = ScopeSet.createSearchScopes(request.scopes);
			const authScheme = request.authenticationScheme || AuthenticationScheme.BEARER;
			const credentialType = authScheme.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase() ? CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME : CredentialType.ACCESS_TOKEN;
			const accessTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType,
				clientId: this.clientId,
				realm: targetRealm || account.tenantId,
				target: scopes,
				tokenType: authScheme,
				keyId: request.sshKid,
				requestedClaimsHash: request.requestedClaimsHash
			};
			const accessTokenKeys = tokenKeys && tokenKeys.accessToken || this.getTokenKeys().accessToken;
			const accessTokens = [];
			accessTokenKeys.forEach((key) => {
				if (this.accessTokenKeyMatchesFilter(key, accessTokenFilter, true)) {
					const accessToken = this.getAccessTokenCredential(key, correlationId);
					if (accessToken && this.credentialMatchesFilter(accessToken, accessTokenFilter)) accessTokens.push(accessToken);
				}
			});
			const numAccessTokens = accessTokens.length;
			if (numAccessTokens < 1) {
				this.commonLogger.info("CacheManager:getAccessToken - No token found", correlationId);
				return null;
			} else if (numAccessTokens > 1) {
				this.commonLogger.info("CacheManager:getAccessToken - Multiple access tokens found, clearing them", correlationId);
				accessTokens.forEach((accessToken) => {
					this.removeAccessToken(this.generateCredentialKey(accessToken), correlationId);
				});
				this.performanceClient.addFields({ multiMatchedAT: accessTokens.length }, correlationId);
				return null;
			}
			this.commonLogger.info("CacheManager:getAccessToken - Returning access token", correlationId);
			return accessTokens[0];
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		* @param keyMustContainAllScopes
		* @returns
		*/
		accessTokenKeyMatchesFilter(inputKey, filter, keyMustContainAllScopes) {
			const key = inputKey.toLowerCase();
			if (filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			if (filter.realm && key.indexOf(filter.realm.toLowerCase()) === -1) return false;
			if (filter.requestedClaimsHash && key.indexOf(filter.requestedClaimsHash.toLowerCase()) === -1) return false;
			if (filter.target) {
				const scopes = filter.target.asArray();
				for (let i = 0; i < scopes.length; i++) if (keyMustContainAllScopes && !key.includes(scopes[i].toLowerCase())) return false;
				else if (!keyMustContainAllScopes && key.includes(scopes[i].toLowerCase())) return true;
			}
			return true;
		}
		/**
		* Gets all access tokens matching the filter
		* @param filter
		* @returns
		*/
		getAccessTokensByFilter(filter, correlationId) {
			const tokenKeys = this.getTokenKeys();
			const accessTokens = [];
			tokenKeys.accessToken.forEach((key) => {
				if (!this.accessTokenKeyMatchesFilter(key, filter, true)) return;
				const accessToken = this.getAccessTokenCredential(key, correlationId);
				if (accessToken && this.credentialMatchesFilter(accessToken, filter)) accessTokens.push(accessToken);
			});
			return accessTokens;
		}
		/**
		* Helper to retrieve the appropriate refresh token from cache
		* @param account {AccountInfo}
		* @param familyRT {boolean}
		* @param correlationId {?string}
		* @param tokenKeys {?TokenKeys}
		* @param performanceClient {?IPerformanceClient}
		*/
		getRefreshToken(account, familyRT, correlationId, tokenKeys, performanceClient) {
			this.commonLogger.trace("CacheManager - getRefreshToken called");
			const id = familyRT ? THE_FAMILY_ID : void 0;
			const refreshTokenFilter = {
				homeAccountId: account.homeAccountId,
				environment: account.environment,
				credentialType: CredentialType.REFRESH_TOKEN,
				clientId: this.clientId,
				familyId: id
			};
			const refreshTokenKeys = tokenKeys && tokenKeys.refreshToken || this.getTokenKeys().refreshToken;
			const refreshTokens = [];
			refreshTokenKeys.forEach((key) => {
				if (this.refreshTokenKeyMatchesFilter(key, refreshTokenFilter)) {
					const refreshToken = this.getRefreshTokenCredential(key, correlationId);
					if (refreshToken && this.credentialMatchesFilter(refreshToken, refreshTokenFilter)) refreshTokens.push(refreshToken);
				}
			});
			const numRefreshTokens = refreshTokens.length;
			if (numRefreshTokens < 1) {
				this.commonLogger.info("CacheManager:getRefreshToken - No refresh token found.");
				return null;
			}
			if (numRefreshTokens > 1 && performanceClient && correlationId) performanceClient.addFields({ multiMatchedRT: numRefreshTokens }, correlationId);
			this.commonLogger.info("CacheManager:getRefreshToken - returning refresh token");
			return refreshTokens[0];
		}
		/**
		* Validate the cache key against filter before retrieving and parsing cache value
		* @param key
		* @param filter
		*/
		refreshTokenKeyMatchesFilter(inputKey, filter) {
			const key = inputKey.toLowerCase();
			if (filter.familyId && key.indexOf(filter.familyId.toLowerCase()) === -1) return false;
			if (!filter.familyId && filter.clientId && key.indexOf(filter.clientId.toLowerCase()) === -1) return false;
			if (filter.homeAccountId && key.indexOf(filter.homeAccountId.toLowerCase()) === -1) return false;
			return true;
		}
		/**
		* Retrieve AppMetadataEntity from cache
		*/
		readAppMetadataFromCache(environment) {
			const appMetadataFilter = {
				environment,
				clientId: this.clientId
			};
			const appMetadata = this.getAppMetadataFilteredBy(appMetadataFilter);
			const appMetadataEntries = Object.keys(appMetadata).map((key) => appMetadata[key]);
			const numAppMetadata = appMetadataEntries.length;
			if (numAppMetadata < 1) return null;
			else if (numAppMetadata > 1) throw createClientAuthError(multipleMatchingAppMetadata);
			return appMetadataEntries[0];
		}
		/**
		* Return the family_id value associated  with FOCI
		* @param environment
		* @param clientId
		*/
		isAppMetadataFOCI(environment) {
			const appMetadata = this.readAppMetadataFromCache(environment);
			return !!(appMetadata && appMetadata.familyId === THE_FAMILY_ID);
		}
		/**
		* helper to match account ids
		* @param value
		* @param homeAccountId
		*/
		matchHomeAccountId(entity, homeAccountId) {
			return !!(typeof entity.homeAccountId === "string" && homeAccountId === entity.homeAccountId);
		}
		/**
		* helper to match account ids
		* @param entity
		* @param localAccountId
		* @returns
		*/
		matchLocalAccountIdFromTokenClaims(tokenClaims, localAccountId) {
			return localAccountId === (tokenClaims.oid || tokenClaims.sub);
		}
		matchLocalAccountIdFromTenantProfile(tenantProfile, localAccountId) {
			return tenantProfile.localAccountId === localAccountId;
		}
		/**
		* helper to match names
		* @param entity
		* @param name
		* @returns true if the downcased name properties are present and match in the filter and the entity
		*/
		matchName(claims, name) {
			return !!(name.toLowerCase() === claims.name?.toLowerCase());
		}
		/**
		* helper to match usernames
		* @param entity
		* @param username
		* @returns
		*/
		matchUsername(cachedUsername, filterUsername) {
			return !!(cachedUsername && typeof cachedUsername === "string" && filterUsername?.toLowerCase() === cachedUsername.toLowerCase());
		}
		/**
		* helper to match assertion
		* @param value
		* @param oboAssertion
		*/
		matchUserAssertionHash(entity, userAssertionHash) {
			return !!(entity.userAssertionHash && userAssertionHash === entity.userAssertionHash);
		}
		/**
		* helper to match environment
		* @param value
		* @param environment
		*/
		matchEnvironment(entity, environment) {
			if (this.staticAuthorityOptions) {
				const staticAliases = getAliasesFromStaticSources(this.staticAuthorityOptions, this.commonLogger);
				if (staticAliases.includes(environment) && staticAliases.includes(entity.environment)) return true;
			}
			const cloudMetadata = this.getAuthorityMetadataByAlias(environment);
			if (cloudMetadata && cloudMetadata.aliases.indexOf(entity.environment) > -1) return true;
			return false;
		}
		/**
		* helper to match credential type
		* @param entity
		* @param credentialType
		*/
		matchCredentialType(entity, credentialType) {
			return entity.credentialType && credentialType.toLowerCase() === entity.credentialType.toLowerCase();
		}
		/**
		* helper to match client ids
		* @param entity
		* @param clientId
		*/
		matchClientId(entity, clientId) {
			return !!(entity.clientId && clientId === entity.clientId);
		}
		/**
		* helper to match family ids
		* @param entity
		* @param familyId
		*/
		matchFamilyId(entity, familyId) {
			return !!(entity.familyId && familyId === entity.familyId);
		}
		/**
		* helper to match realm
		* @param entity
		* @param realm
		*/
		matchRealm(entity, realm) {
			return !!(entity.realm?.toLowerCase() === realm.toLowerCase());
		}
		/**
		* helper to match nativeAccountId
		* @param entity
		* @param nativeAccountId
		* @returns boolean indicating the match result
		*/
		matchNativeAccountId(entity, nativeAccountId) {
			return !!(entity.nativeAccountId && nativeAccountId === entity.nativeAccountId);
		}
		/**
		* helper to match loginHint which can be either:
		* 1. login_hint ID token claim
		* 2. username in cached account object
		* 3. upn in ID token claims
		* @param entity
		* @param loginHint
		* @returns
		*/
		matchLoginHintFromTokenClaims(tokenClaims, loginHint) {
			if (tokenClaims.login_hint === loginHint) return true;
			if (tokenClaims.preferred_username === loginHint) return true;
			if (tokenClaims.upn === loginHint) return true;
			return false;
		}
		/**
		* Helper to match sid
		* @param entity
		* @param sid
		* @returns true if the sid claim is present and matches the filter
		*/
		matchSid(idTokenClaims, sid) {
			return idTokenClaims.sid === sid;
		}
		matchAuthorityType(entity, authorityType) {
			return !!(entity.authorityType && authorityType.toLowerCase() === entity.authorityType.toLowerCase());
		}
		/**
		* Returns true if the target scopes are a subset of the current entity's scopes, false otherwise.
		* @param entity
		* @param target
		*/
		matchTarget(entity, target) {
			if (entity.credentialType !== CredentialType.ACCESS_TOKEN && entity.credentialType !== CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME || !entity.target) return false;
			return ScopeSet.fromString(entity.target).containsScopeSet(target);
		}
		/**
		* Returns true if the credential's tokenType or Authentication Scheme matches the one in the request, false otherwise
		* @param entity
		* @param tokenType
		*/
		matchTokenType(entity, tokenType) {
			return !!(entity.tokenType && entity.tokenType === tokenType);
		}
		/**
		* Returns true if the credential's keyId matches the one in the request, false otherwise
		* @param entity
		* @param keyId
		*/
		matchKeyId(entity, keyId) {
			return !!(entity.keyId && entity.keyId === keyId);
		}
		/**
		* returns if a given cache entity is of the type appmetadata
		* @param key
		*/
		isAppMetadata(key) {
			return key.indexOf(APP_METADATA) !== -1;
		}
		/**
		* returns if a given cache entity is of the type authoritymetadata
		* @param key
		*/
		isAuthorityMetadata(key) {
			return key.indexOf(AUTHORITY_METADATA_CONSTANTS.CACHE_KEY) !== -1;
		}
		/**
		* returns cache key used for cloud instance metadata
		*/
		generateAuthorityMetadataCacheKey(authority) {
			return `${AUTHORITY_METADATA_CONSTANTS.CACHE_KEY}-${this.clientId}-${authority}`;
		}
		/**
		* Helper to convert serialized data to object
		* @param obj
		* @param json
		*/
		static toObject(obj, json) {
			for (const propertyName in json) obj[propertyName] = json[propertyName];
			return obj;
		}
	};
	/** @internal */
	var DefaultStorageClass = class extends CacheManager {
		async setAccount() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccount() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setIdTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getIdTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setAccessTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccessTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		async setRefreshTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		getRefreshTokenCredential() {
			throw createClientAuthError(methodNotImplemented);
		}
		setAppMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAppMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		setServerTelemetry() {
			throw createClientAuthError(methodNotImplemented);
		}
		getServerTelemetry() {
			throw createClientAuthError(methodNotImplemented);
		}
		setAuthorityMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAuthorityMetadata() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAuthorityMetadataKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		setThrottlingCache() {
			throw createClientAuthError(methodNotImplemented);
		}
		getThrottlingCache() {
			throw createClientAuthError(methodNotImplemented);
		}
		removeItem() {
			throw createClientAuthError(methodNotImplemented);
		}
		getKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		getAccountKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		getTokenKeys() {
			throw createClientAuthError(methodNotImplemented);
		}
		generateCredentialKey() {
			throw createClientAuthError(methodNotImplemented);
		}
		generateAccountKey() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Enumeration of operations that are instrumented by have their performance measured by the PerformanceClient.
	*
	* @export
	* @enum {number}
	*/
	const PerformanceEvents = {
		/**
		* acquireTokenByCode API (msal-browser and msal-node).
		* Used to acquire tokens by trading an authorization code against the token endpoint.
		*/
		AcquireTokenByCode: "acquireTokenByCode",
		/**
		* acquireTokenByRefreshToken API (msal-browser and msal-node).
		* Used to renew an access token using a refresh token against the token endpoint.
		*/
		AcquireTokenByRefreshToken: "acquireTokenByRefreshToken",
		/**
		* acquireTokenSilent API (msal-browser and msal-node).
		* Used to silently acquire a new access token (from the cache or the network).
		*/
		AcquireTokenSilent: "acquireTokenSilent",
		/**
		* acquireTokenSilentAsync (msal-browser).
		* Internal API for acquireTokenSilent.
		*/
		AcquireTokenSilentAsync: "acquireTokenSilentAsync",
		/**
		* acquireTokenPopup (msal-browser).
		* Used to acquire a new access token interactively through pop ups
		*/
		AcquireTokenPopup: "acquireTokenPopup",
		/**
		* acquireTokenPreRedirect (msal-browser).
		* First part of the redirect flow.
		* Used to acquire a new access token interactively through redirects.
		*/
		AcquireTokenPreRedirect: "acquireTokenPreRedirect",
		/**
		* acquireTokenRedirect (msal-browser).
		* Second part of the redirect flow.
		* Used to acquire a new access token interactively through redirects.
		*/
		AcquireTokenRedirect: "acquireTokenRedirect",
		/**
		* getPublicKeyThumbprint API in CryptoOpts class (msal-browser).
		* Used to generate a public/private keypair and generate a public key thumbprint for pop requests.
		*/
		CryptoOptsGetPublicKeyThumbprint: "cryptoOptsGetPublicKeyThumbprint",
		/**
		* signJwt API in CryptoOpts class (msal-browser).
		* Used to signed a pop token.
		*/
		CryptoOptsSignJwt: "cryptoOptsSignJwt",
		/**
		* acquireToken API in the SilentCacheClient class (msal-browser).
		* Used to read access tokens from the cache.
		*/
		SilentCacheClientAcquireToken: "silentCacheClientAcquireToken",
		/**
		* acquireToken API in the SilentIframeClient class (msal-browser).
		* Used to acquire a new set of tokens from the authorize endpoint in a hidden iframe.
		*/
		SilentIframeClientAcquireToken: "silentIframeClientAcquireToken",
		AwaitConcurrentIframe: "awaitConcurrentIframe",
		/**
		* acquireToken API in SilentRereshClient (msal-browser).
		* Used to acquire a new set of tokens from the token endpoint using a refresh token.
		*/
		SilentRefreshClientAcquireToken: "silentRefreshClientAcquireToken",
		/**
		* ssoSilent API (msal-browser).
		* Used to silently acquire an authorization code and set of tokens using a hidden iframe.
		*/
		SsoSilent: "ssoSilent",
		/**
		* getDiscoveredAuthority API in StandardInteractionClient class (msal-browser).
		* Used to load authority metadata for a request.
		*/
		StandardInteractionClientGetDiscoveredAuthority: "standardInteractionClientGetDiscoveredAuthority",
		/**
		* acquireToken APIs in msal-browser.
		* Used to make an /authorize endpoint call with native brokering enabled.
		*/
		FetchAccountIdWithNativeBroker: "fetchAccountIdWithNativeBroker",
		/**
		* acquireToken API in NativeInteractionClient class (msal-browser).
		* Used to acquire a token from Native component when native brokering is enabled.
		*/
		NativeInteractionClientAcquireToken: "nativeInteractionClientAcquireToken",
		/**
		* Time spent creating default headers for requests to token endpoint
		*/
		BaseClientCreateTokenRequestHeaders: "baseClientCreateTokenRequestHeaders",
		/**
		* Time spent sending/waiting for the response of a request to the token endpoint
		*/
		NetworkClientSendPostRequestAsync: "networkClientSendPostRequestAsync",
		RefreshTokenClientExecutePostToTokenEndpoint: "refreshTokenClientExecutePostToTokenEndpoint",
		AuthorizationCodeClientExecutePostToTokenEndpoint: "authorizationCodeClientExecutePostToTokenEndpoint",
		/**
		* Used to measure the time taken for completing embedded-broker handshake (PW-Broker).
		*/
		BrokerHandhshake: "brokerHandshake",
		/**
		* acquireTokenByRefreshToken API in BrokerClientApplication (PW-Broker) .
		*/
		AcquireTokenByRefreshTokenInBroker: "acquireTokenByRefreshTokenInBroker",
		/**
		* Time taken for token acquisition by broker
		*/
		AcquireTokenByBroker: "acquireTokenByBroker",
		/**
		* Time spent on the network for refresh token acquisition
		*/
		RefreshTokenClientExecuteTokenRequest: "refreshTokenClientExecuteTokenRequest",
		/**
		* Time taken for acquiring refresh token , records RT size
		*/
		RefreshTokenClientAcquireToken: "refreshTokenClientAcquireToken",
		/**
		* Time taken for acquiring cached refresh token
		*/
		RefreshTokenClientAcquireTokenWithCachedRefreshToken: "refreshTokenClientAcquireTokenWithCachedRefreshToken",
		/**
		* acquireTokenByRefreshToken API in RefreshTokenClient (msal-common).
		*/
		RefreshTokenClientAcquireTokenByRefreshToken: "refreshTokenClientAcquireTokenByRefreshToken",
		/**
		* Helper function to create token request body in RefreshTokenClient (msal-common).
		*/
		RefreshTokenClientCreateTokenRequestBody: "refreshTokenClientCreateTokenRequestBody",
		/**
		* acquireTokenFromCache (msal-browser).
		* Internal API for acquiring token from cache
		*/
		AcquireTokenFromCache: "acquireTokenFromCache",
		SilentFlowClientAcquireCachedToken: "silentFlowClientAcquireCachedToken",
		SilentFlowClientGenerateResultFromCacheRecord: "silentFlowClientGenerateResultFromCacheRecord",
		/**
		* acquireTokenBySilentIframe (msal-browser).
		* Internal API for acquiring token by silent Iframe
		*/
		AcquireTokenBySilentIframe: "acquireTokenBySilentIframe",
		/**
		* Internal API for initializing base request in BaseInteractionClient (msal-browser)
		*/
		InitializeBaseRequest: "initializeBaseRequest",
		/**
		* Internal API for initializing silent request in SilentCacheClient (msal-browser)
		*/
		InitializeSilentRequest: "initializeSilentRequest",
		InitializeClientApplication: "initializeClientApplication",
		InitializeCache: "initializeCache",
		/**
		* Helper function in SilentIframeClient class (msal-browser).
		*/
		SilentIframeClientTokenHelper: "silentIframeClientTokenHelper",
		/**
		* SilentHandler
		*/
		SilentHandlerInitiateAuthRequest: "silentHandlerInitiateAuthRequest",
		SilentHandlerMonitorIframeForHash: "silentHandlerMonitorIframeForHash",
		SilentHandlerLoadFrame: "silentHandlerLoadFrame",
		SilentHandlerLoadFrameSync: "silentHandlerLoadFrameSync",
		/**
		* Helper functions in StandardInteractionClient class (msal-browser)
		*/
		StandardInteractionClientCreateAuthCodeClient: "standardInteractionClientCreateAuthCodeClient",
		StandardInteractionClientGetClientConfiguration: "standardInteractionClientGetClientConfiguration",
		StandardInteractionClientInitializeAuthorizationRequest: "standardInteractionClientInitializeAuthorizationRequest",
		/**
		* getAuthCodeUrl API (msal-browser and msal-node).
		*/
		GetAuthCodeUrl: "getAuthCodeUrl",
		GetStandardParams: "getStandardParams",
		/**
		* Functions from InteractionHandler (msal-browser)
		*/
		HandleCodeResponseFromServer: "handleCodeResponseFromServer",
		HandleCodeResponse: "handleCodeResponse",
		HandleResponseEar: "handleResponseEar",
		HandleResponsePlatformBroker: "handleResponsePlatformBroker",
		HandleResponseCode: "handleResponseCode",
		UpdateTokenEndpointAuthority: "updateTokenEndpointAuthority",
		/**
		* APIs in Authorization Code Client (msal-common)
		*/
		AuthClientAcquireToken: "authClientAcquireToken",
		AuthClientExecuteTokenRequest: "authClientExecuteTokenRequest",
		AuthClientCreateTokenRequestBody: "authClientCreateTokenRequestBody",
		/**
		* Generate functions in PopTokenGenerator (msal-common)
		*/
		PopTokenGenerateCnf: "popTokenGenerateCnf",
		PopTokenGenerateKid: "popTokenGenerateKid",
		/**
		* handleServerTokenResponse API in ResponseHandler (msal-common)
		*/
		HandleServerTokenResponse: "handleServerTokenResponse",
		DeserializeResponse: "deserializeResponse",
		/**
		* Authority functions
		*/
		AuthorityFactoryCreateDiscoveredInstance: "authorityFactoryCreateDiscoveredInstance",
		AuthorityResolveEndpointsAsync: "authorityResolveEndpointsAsync",
		AuthorityResolveEndpointsFromLocalSources: "authorityResolveEndpointsFromLocalSources",
		AuthorityGetCloudDiscoveryMetadataFromNetwork: "authorityGetCloudDiscoveryMetadataFromNetwork",
		AuthorityUpdateCloudDiscoveryMetadata: "authorityUpdateCloudDiscoveryMetadata",
		AuthorityGetEndpointMetadataFromNetwork: "authorityGetEndpointMetadataFromNetwork",
		AuthorityUpdateEndpointMetadata: "authorityUpdateEndpointMetadata",
		AuthorityUpdateMetadataWithRegionalInformation: "authorityUpdateMetadataWithRegionalInformation",
		/**
		* Region Discovery functions
		*/
		RegionDiscoveryDetectRegion: "regionDiscoveryDetectRegion",
		RegionDiscoveryGetRegionFromIMDS: "regionDiscoveryGetRegionFromIMDS",
		RegionDiscoveryGetCurrentVersion: "regionDiscoveryGetCurrentVersion",
		AcquireTokenByCodeAsync: "acquireTokenByCodeAsync",
		GetEndpointMetadataFromNetwork: "getEndpointMetadataFromNetwork",
		GetCloudDiscoveryMetadataFromNetworkMeasurement: "getCloudDiscoveryMetadataFromNetworkMeasurement",
		HandleRedirectPromiseMeasurement: "handleRedirectPromise",
		HandleNativeRedirectPromiseMeasurement: "handleNativeRedirectPromise",
		UpdateCloudDiscoveryMetadataMeasurement: "updateCloudDiscoveryMetadataMeasurement",
		UsernamePasswordClientAcquireToken: "usernamePasswordClientAcquireToken",
		NativeMessageHandlerHandshake: "nativeMessageHandlerHandshake",
		NativeGenerateAuthResult: "nativeGenerateAuthResult",
		RemoveHiddenIframe: "removeHiddenIframe",
		/**
		* Cache operations
		*/
		ClearTokensAndKeysWithClaims: "clearTokensAndKeysWithClaims",
		CacheManagerGetRefreshToken: "cacheManagerGetRefreshToken",
		ImportExistingCache: "importExistingCache",
		SetUserData: "setUserData",
		LocalStorageUpdated: "localStorageUpdated",
		/**
		* Crypto Operations
		*/
		GeneratePkceCodes: "generatePkceCodes",
		GenerateCodeVerifier: "generateCodeVerifier",
		GenerateCodeChallengeFromVerifier: "generateCodeChallengeFromVerifier",
		Sha256Digest: "sha256Digest",
		GetRandomValues: "getRandomValues",
		GenerateHKDF: "generateHKDF",
		GenerateBaseKey: "generateBaseKey",
		Base64Decode: "base64Decode",
		UrlEncodeArr: "urlEncodeArr",
		Encrypt: "encrypt",
		Decrypt: "decrypt",
		GenerateEarKey: "generateEarKey",
		DecryptEarResponse: "decryptEarResponse",
		LoadExternalTokens: "LoadExternalTokens",
		LoadAccount: "loadAccount",
		LoadIdToken: "loadIdToken",
		LoadAccessToken: "loadAccessToken",
		LoadRefreshToken: "loadRefreshToken",
		/**
		* SSO capability verification call (msal-browser).
		* Fire-and-forget SSO verification call made after interactive authentication completes.
		*/
		SsoCapable: "ssoCapable"
	};
	/**
	* State of the performance event.
	*
	* @export
	* @enum {number}
	*/
	const PerformanceEventStatus = { InProgress: 1 };
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	var StubPerformanceMeasurement = class {
		startMeasurement() {}
		endMeasurement() {}
		flushMeasurement() {
			return null;
		}
	};
	var StubPerformanceClient = class {
		generateId() {
			return "callback-id";
		}
		startMeasurement(measureName, correlationId) {
			return {
				end: () => null,
				discard: () => {},
				add: () => {},
				increment: () => {},
				event: {
					eventId: this.generateId(),
					status: PerformanceEventStatus.InProgress,
					authority: "",
					libraryName: "",
					libraryVersion: "",
					clientId: "",
					name: measureName,
					startTimeMs: Date.now(),
					correlationId: correlationId || ""
				},
				measurement: new StubPerformanceMeasurement()
			};
		}
		startPerformanceMeasurement() {
			return new StubPerformanceMeasurement();
		}
		calculateQueuedTime() {
			return 0;
		}
		addQueueMeasurement() {}
		setPreQueueTime() {}
		endMeasurement() {
			return null;
		}
		discardMeasurements() {}
		removePerformanceCallback() {
			return true;
		}
		addPerformanceCallback() {
			return "";
		}
		emitEvents() {}
		addFields() {}
		incrementFields() {}
		cacheEventByCorrelationId() {}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const DEFAULT_SYSTEM_OPTIONS$1 = {
		tokenRenewalOffsetSeconds: DEFAULT_TOKEN_RENEWAL_OFFSET_SEC,
		preventCorsPreflight: false
	};
	const DEFAULT_LOGGER_IMPLEMENTATION = {
		loggerCallback: () => {},
		piiLoggingEnabled: false,
		logLevel: exports.LogLevel.Info,
		correlationId: Constants$1.EMPTY_STRING
	};
	const DEFAULT_CACHE_OPTIONS$1 = { claimsBasedCachingEnabled: false };
	const DEFAULT_NETWORK_IMPLEMENTATION = {
		async sendGetRequestAsync() {
			throw createClientAuthError(methodNotImplemented);
		},
		async sendPostRequestAsync() {
			throw createClientAuthError(methodNotImplemented);
		}
	};
	const DEFAULT_LIBRARY_INFO = {
		sku: Constants$1.SKU,
		version: version$1,
		cpu: Constants$1.EMPTY_STRING,
		os: Constants$1.EMPTY_STRING
	};
	const DEFAULT_CLIENT_CREDENTIALS = {
		clientSecret: Constants$1.EMPTY_STRING,
		clientAssertion: void 0
	};
	const DEFAULT_AZURE_CLOUD_OPTIONS = {
		azureCloudInstance: AzureCloudInstance.None,
		tenant: `${Constants$1.DEFAULT_COMMON_TENANT}`
	};
	const DEFAULT_TELEMETRY_OPTIONS$1 = { application: {
		appName: "",
		appVersion: ""
	} };
	/**
	* Function that sets the default options when not explicitly configured from app developer
	*
	* @param Configuration
	*
	* @returns Configuration
	*/
	function buildClientConfiguration({ authOptions: userAuthOptions, systemOptions: userSystemOptions, loggerOptions: userLoggerOption, cacheOptions: userCacheOptions, storageInterface: storageImplementation, networkInterface: networkImplementation, cryptoInterface: cryptoImplementation, clientCredentials, libraryInfo, telemetry, serverTelemetryManager, persistencePlugin, serializableCache }) {
		const loggerOptions = {
			...DEFAULT_LOGGER_IMPLEMENTATION,
			...userLoggerOption
		};
		return {
			authOptions: buildAuthOptions(userAuthOptions),
			systemOptions: {
				...DEFAULT_SYSTEM_OPTIONS$1,
				...userSystemOptions
			},
			loggerOptions,
			cacheOptions: {
				...DEFAULT_CACHE_OPTIONS$1,
				...userCacheOptions
			},
			storageInterface: storageImplementation || new DefaultStorageClass(userAuthOptions.clientId, DEFAULT_CRYPTO_IMPLEMENTATION, new Logger(loggerOptions), new StubPerformanceClient()),
			networkInterface: networkImplementation || DEFAULT_NETWORK_IMPLEMENTATION,
			cryptoInterface: cryptoImplementation || DEFAULT_CRYPTO_IMPLEMENTATION,
			clientCredentials: clientCredentials || DEFAULT_CLIENT_CREDENTIALS,
			libraryInfo: {
				...DEFAULT_LIBRARY_INFO,
				...libraryInfo
			},
			telemetry: {
				...DEFAULT_TELEMETRY_OPTIONS$1,
				...telemetry
			},
			serverTelemetryManager: serverTelemetryManager || null,
			persistencePlugin: persistencePlugin || null,
			serializableCache: serializableCache || null
		};
	}
	/**
	* Construct authoptions from the client and platform passed values
	* @param authOptions
	*/
	function buildAuthOptions(authOptions) {
		return {
			clientCapabilities: [],
			azureCloudOptions: DEFAULT_AZURE_CLOUD_OPTIONS,
			skipAuthorityMetadataCache: false,
			instanceAware: false,
			encodeExtraQueryParams: false,
			...authOptions
		};
	}
	/**
	* Returns true if config has protocolMode set to ProtocolMode.OIDC, false otherwise
	* @param ClientConfiguration
	*/
	function isOidcProtocolMode(config) {
		return config.authOptions.authority.options.protocolMode === ProtocolMode.OIDC;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const CcsCredentialType = {
		HOME_ACCOUNT_ID: "home_account_id",
		UPN: "UPN"
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const CLIENT_ID = "client_id";
	const REDIRECT_URI = "redirect_uri";
	const RESPONSE_TYPE = "response_type";
	const RESPONSE_MODE = "response_mode";
	const GRANT_TYPE = "grant_type";
	const CLAIMS = "claims";
	const SCOPE = "scope";
	const REFRESH_TOKEN = "refresh_token";
	const STATE = "state";
	const NONCE = "nonce";
	const PROMPT = "prompt";
	const CODE = "code";
	const CODE_CHALLENGE = "code_challenge";
	const CODE_CHALLENGE_METHOD = "code_challenge_method";
	const CODE_VERIFIER = "code_verifier";
	const CLIENT_REQUEST_ID = "client-request-id";
	const X_CLIENT_SKU = "x-client-SKU";
	const X_CLIENT_VER = "x-client-VER";
	const X_CLIENT_OS = "x-client-OS";
	const X_CLIENT_CPU = "x-client-CPU";
	const X_CLIENT_CURR_TELEM = "x-client-current-telemetry";
	const X_CLIENT_LAST_TELEM = "x-client-last-telemetry";
	const X_MS_LIB_CAPABILITY = "x-ms-lib-capability";
	const X_APP_NAME = "x-app-name";
	const X_APP_VER = "x-app-ver";
	const POST_LOGOUT_URI = "post_logout_redirect_uri";
	const ID_TOKEN_HINT = "id_token_hint";
	const DEVICE_CODE = "device_code";
	const CLIENT_SECRET = "client_secret";
	const CLIENT_ASSERTION = "client_assertion";
	const CLIENT_ASSERTION_TYPE = "client_assertion_type";
	const TOKEN_TYPE = "token_type";
	const REQ_CNF = "req_cnf";
	const OBO_ASSERTION = "assertion";
	const REQUESTED_TOKEN_USE = "requested_token_use";
	const ON_BEHALF_OF = "on_behalf_of";
	const RETURN_SPA_CODE = "return_spa_code";
	const LOGOUT_HINT = "logout_hint";
	const SID = "sid";
	const LOGIN_HINT = "login_hint";
	const DOMAIN_HINT = "domain_hint";
	const X_CLIENT_EXTRA_SKU = "x-client-xtra-sku";
	const BROKER_CLIENT_ID = "brk_client_id";
	const BROKER_REDIRECT_URI = "brk_redirect_uri";
	const INSTANCE_AWARE = "instance_aware";
	const CLI_DATA = "clidata";
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	function instrumentBrokerParams(parameters, correlationId, performanceClient) {
		if (!correlationId) return;
		const clientId = parameters.get(CLIENT_ID);
		if (clientId && parameters.has(BROKER_CLIENT_ID)) performanceClient?.addFields({
			embeddedClientId: clientId,
			embeddedRedirectUri: parameters.get(REDIRECT_URI)
		}, correlationId);
	}
	/**
	* Add the given response_type
	* @param parameters
	* @param responseType
	*/
	function addResponseType(parameters, responseType) {
		parameters.set(RESPONSE_TYPE, responseType);
	}
	/**
	* add response_mode. defaults to query.
	* @param responseMode
	*/
	function addResponseMode(parameters, responseMode) {
		parameters.set(RESPONSE_MODE, responseMode ? responseMode : ResponseMode.QUERY);
	}
	/**
	* add scopes. set addOidcScopes to false to prevent default scopes in non-user scenarios
	* @param scopeSet
	* @param addOidcScopes
	*/
	function addScopes(parameters, scopes, addOidcScopes = true, defaultScopes = OIDC_DEFAULT_SCOPES) {
		if (addOidcScopes && !defaultScopes.includes("openid") && !scopes.includes("openid")) defaultScopes.push("openid");
		const scopeSet = new ScopeSet(addOidcScopes ? [...scopes || [], ...defaultScopes] : scopes || []);
		parameters.set(SCOPE, scopeSet.printScopes());
	}
	/**
	* add clientId
	* @param clientId
	*/
	function addClientId(parameters, clientId) {
		parameters.set(CLIENT_ID, clientId);
	}
	/**
	* add redirect_uri
	* @param redirectUri
	*/
	function addRedirectUri(parameters, redirectUri) {
		parameters.set(REDIRECT_URI, redirectUri);
	}
	/**
	* add post logout redirectUri
	* @param redirectUri
	*/
	function addPostLogoutRedirectUri(parameters, redirectUri) {
		parameters.set(POST_LOGOUT_URI, redirectUri);
	}
	/**
	* add id_token_hint to logout request
	* @param idTokenHint
	*/
	function addIdTokenHint(parameters, idTokenHint) {
		parameters.set(ID_TOKEN_HINT, idTokenHint);
	}
	/**
	* add domain_hint
	* @param domainHint
	*/
	function addDomainHint(parameters, domainHint) {
		parameters.set(DOMAIN_HINT, domainHint);
	}
	/**
	* add login_hint
	* @param loginHint
	*/
	function addLoginHint(parameters, loginHint) {
		parameters.set(LOGIN_HINT, loginHint);
	}
	/**
	* Adds the CCS (Cache Credential Service) query parameter for login_hint
	* @param loginHint
	*/
	function addCcsUpn(parameters, loginHint) {
		parameters.set(HeaderNames.CCS_HEADER, `UPN:${loginHint}`);
	}
	/**
	* Adds the CCS (Cache Credential Service) query parameter for account object
	* @param loginHint
	*/
	function addCcsOid(parameters, clientInfo) {
		parameters.set(HeaderNames.CCS_HEADER, `Oid:${clientInfo.uid}@${clientInfo.utid}`);
	}
	/**
	* add sid
	* @param sid
	*/
	function addSid(parameters, sid) {
		parameters.set(SID, sid);
	}
	/**
	* add claims
	* @param claims
	*/
	function addClaims(parameters, claims, clientCapabilities) {
		const mergedClaims = addClientCapabilitiesToClaims(claims, clientCapabilities);
		try {
			JSON.parse(mergedClaims);
		} catch (e) {
			throw createClientConfigurationError(invalidClaims);
		}
		parameters.set(CLAIMS, mergedClaims);
	}
	/**
	* add correlationId
	* @param correlationId
	*/
	function addCorrelationId(parameters, correlationId) {
		parameters.set(CLIENT_REQUEST_ID, correlationId);
	}
	/**
	* add library info query params
	* @param libraryInfo
	*/
	function addLibraryInfo(parameters, libraryInfo) {
		parameters.set(X_CLIENT_SKU, libraryInfo.sku);
		parameters.set(X_CLIENT_VER, libraryInfo.version);
		if (libraryInfo.os) parameters.set(X_CLIENT_OS, libraryInfo.os);
		if (libraryInfo.cpu) parameters.set(X_CLIENT_CPU, libraryInfo.cpu);
	}
	/**
	* Add client telemetry parameters
	* @param appTelemetry
	*/
	function addApplicationTelemetry(parameters, appTelemetry) {
		if (appTelemetry?.appName) parameters.set(X_APP_NAME, appTelemetry.appName);
		if (appTelemetry?.appVersion) parameters.set(X_APP_VER, appTelemetry.appVersion);
	}
	/**
	* add prompt
	* @param prompt
	*/
	function addPrompt(parameters, prompt) {
		parameters.set(PROMPT, prompt);
	}
	/**
	* add state
	* @param state
	*/
	function addState(parameters, state) {
		if (state) parameters.set(STATE, state);
	}
	/**
	* add nonce
	* @param nonce
	*/
	function addNonce(parameters, nonce) {
		parameters.set(NONCE, nonce);
	}
	/**
	* add code_challenge and code_challenge_method
	* - throw if either of them are not passed
	* @param codeChallenge
	* @param codeChallengeMethod
	*/
	function addCodeChallengeParams(parameters, codeChallenge, codeChallengeMethod) {
		if (codeChallenge && codeChallengeMethod) {
			parameters.set(CODE_CHALLENGE, codeChallenge);
			parameters.set(CODE_CHALLENGE_METHOD, codeChallengeMethod);
		} else throw createClientConfigurationError(pkceParamsMissing);
	}
	/**
	* add the `authorization_code` passed by the user to exchange for a token
	* @param code
	*/
	function addAuthorizationCode(parameters, code) {
		parameters.set(CODE, code);
	}
	/**
	* add the `authorization_code` passed by the user to exchange for a token
	* @param code
	*/
	function addDeviceCode(parameters, code) {
		parameters.set(DEVICE_CODE, code);
	}
	/**
	* add the `refreshToken` passed by the user
	* @param refreshToken
	*/
	function addRefreshToken(parameters, refreshToken) {
		parameters.set(REFRESH_TOKEN, refreshToken);
	}
	/**
	* add the `code_verifier` passed by the user to exchange for a token
	* @param codeVerifier
	*/
	function addCodeVerifier(parameters, codeVerifier) {
		parameters.set(CODE_VERIFIER, codeVerifier);
	}
	/**
	* add client_secret
	* @param clientSecret
	*/
	function addClientSecret(parameters, clientSecret) {
		parameters.set(CLIENT_SECRET, clientSecret);
	}
	/**
	* add clientAssertion for confidential client flows
	* @param clientAssertion
	*/
	function addClientAssertion(parameters, clientAssertion) {
		if (clientAssertion) parameters.set(CLIENT_ASSERTION, clientAssertion);
	}
	/**
	* add clientAssertionType for confidential client flows
	* @param clientAssertionType
	*/
	function addClientAssertionType(parameters, clientAssertionType) {
		if (clientAssertionType) parameters.set(CLIENT_ASSERTION_TYPE, clientAssertionType);
	}
	/**
	* add OBO assertion for confidential client flows
	* @param clientAssertion
	*/
	function addOboAssertion(parameters, oboAssertion) {
		parameters.set(OBO_ASSERTION, oboAssertion);
	}
	/**
	* add grant type
	* @param grantType
	*/
	function addRequestTokenUse(parameters, tokenUse) {
		parameters.set(REQUESTED_TOKEN_USE, tokenUse);
	}
	/**
	* add grant type
	* @param grantType
	*/
	function addGrantType(parameters, grantType) {
		parameters.set(GRANT_TYPE, grantType);
	}
	/**
	* add client info
	*
	*/
	function addClientInfo(parameters) {
		parameters.set(CLIENT_INFO, "1");
	}
	/**
	* add clidata=1 to request to indicate client data support
	*/
	function addCliData(parameters) {
		parameters.set(CLI_DATA, "1");
	}
	function addInstanceAware(parameters) {
		if (!parameters.has(INSTANCE_AWARE)) parameters.set(INSTANCE_AWARE, "true");
	}
	/**
	* add extraQueryParams
	* @param eQParams
	*/
	function addExtraQueryParameters(parameters, eQParams) {
		Object.entries(eQParams).forEach(([key, value]) => {
			if (!parameters.has(key) && value) parameters.set(key, value);
		});
	}
	function addClientCapabilitiesToClaims(claims, clientCapabilities) {
		let mergedClaims;
		if (!claims) mergedClaims = {};
		else try {
			mergedClaims = JSON.parse(claims);
		} catch (e) {
			throw createClientConfigurationError(invalidClaims);
		}
		if (clientCapabilities && clientCapabilities.length > 0) {
			if (!mergedClaims.hasOwnProperty(ClaimsRequestKeys.ACCESS_TOKEN)) mergedClaims[ClaimsRequestKeys.ACCESS_TOKEN] = {};
			mergedClaims[ClaimsRequestKeys.ACCESS_TOKEN][ClaimsRequestKeys.XMS_CC] = { values: clientCapabilities };
		}
		return JSON.stringify(mergedClaims);
	}
	/**
	* adds `username` for Password Grant flow
	* @param username
	*/
	function addUsername(parameters, username) {
		parameters.set(PasswordGrantConstants.username, username);
	}
	/**
	* adds `password` for Password Grant flow
	* @param password
	*/
	function addPassword(parameters, password) {
		parameters.set(PasswordGrantConstants.password, password);
	}
	/**
	* add pop_jwk to query params
	* @param cnfString
	*/
	function addPopToken(parameters, cnfString) {
		if (cnfString) {
			parameters.set(TOKEN_TYPE, AuthenticationScheme.POP);
			parameters.set(REQ_CNF, cnfString);
		}
	}
	/**
	* add SSH JWK and key ID to query params
	*/
	function addSshJwk(parameters, sshJwkString) {
		if (sshJwkString) {
			parameters.set(TOKEN_TYPE, AuthenticationScheme.SSH);
			parameters.set(REQ_CNF, sshJwkString);
		}
	}
	/**
	* add server telemetry fields
	* @param serverTelemetryManager
	*/
	function addServerTelemetry(parameters, serverTelemetryManager) {
		parameters.set(X_CLIENT_CURR_TELEM, serverTelemetryManager.generateCurrentRequestHeaderValue());
		parameters.set(X_CLIENT_LAST_TELEM, serverTelemetryManager.generateLastRequestHeaderValue());
	}
	/**
	* Adds parameter that indicates to the server that throttling is supported
	*/
	function addThrottling(parameters) {
		parameters.set(X_MS_LIB_CAPABILITY, ThrottlingConstants.X_MS_LIB_CAPABILITY_VALUE);
	}
	/**
	* Adds logout_hint parameter for "silent" logout which prevent server account picker
	*/
	function addLogoutHint(parameters, logoutHint) {
		parameters.set(LOGOUT_HINT, logoutHint);
	}
	function addBrokerParameters(parameters, brokerClientId, brokerRedirectUri) {
		if (!parameters.has(BROKER_CLIENT_ID)) parameters.set(BROKER_CLIENT_ID, brokerClientId);
		if (!parameters.has(BROKER_REDIRECT_URI)) parameters.set(BROKER_REDIRECT_URI, brokerRedirectUri);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	function isOpenIdConfigResponse(response) {
		return response.hasOwnProperty("authorization_endpoint") && response.hasOwnProperty("token_endpoint") && response.hasOwnProperty("issuer") && response.hasOwnProperty("jwks_uri");
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	function isCloudInstanceDiscoveryResponse(response) {
		return response.hasOwnProperty("tenant_discovery_endpoint") && response.hasOwnProperty("metadata");
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	function isCloudInstanceDiscoveryErrorResponse(response) {
		return response.hasOwnProperty("error") && response.hasOwnProperty("error_description");
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Wraps a function with a performance measurement.
	* Usage: invoke(functionToCall, performanceClient, "EventName", "correlationId")(...argsToPassToFunction)
	* @param callback
	* @param eventName
	* @param logger
	* @param telemetryClient
	* @param correlationId
	* @returns
	* @internal
	*/
	const invoke = (callback, eventName, logger, telemetryClient, correlationId) => {
		return (...args) => {
			logger.trace(`Executing function ${eventName}`);
			const inProgressEvent = telemetryClient?.startMeasurement(eventName, correlationId);
			if (correlationId) {
				const eventCount = eventName + "CallCount";
				telemetryClient?.incrementFields({ [eventCount]: 1 }, correlationId);
			}
			try {
				const result = callback(...args);
				inProgressEvent?.end({ success: true });
				logger.trace(`Returning result from ${eventName}`);
				return result;
			} catch (e) {
				logger.trace(`Error occurred in ${eventName}`);
				try {
					logger.trace(JSON.stringify(e));
				} catch (e) {
					logger.trace("Unable to print error message.");
				}
				inProgressEvent?.end({ success: false }, e);
				throw e;
			}
		};
	};
	/**
	* Wraps an async function with a performance measurement.
	* Usage: invokeAsync(functionToCall, performanceClient, "EventName", "correlationId")(...argsToPassToFunction)
	* @param callback
	* @param eventName
	* @param logger
	* @param telemetryClient
	* @param correlationId
	* @returns
	* @internal
	*
	*/
	const invokeAsync = (callback, eventName, logger, telemetryClient, correlationId) => {
		return (...args) => {
			logger.trace(`Executing function ${eventName}`);
			const inProgressEvent = telemetryClient?.startMeasurement(eventName, correlationId);
			if (correlationId) {
				const eventCount = eventName + "CallCount";
				telemetryClient?.incrementFields({ [eventCount]: 1 }, correlationId);
			}
			telemetryClient?.setPreQueueTime(eventName, correlationId);
			return callback(...args).then((response) => {
				logger.trace(`Returning result from ${eventName}`);
				inProgressEvent?.end({ success: true });
				return response;
			}).catch((e) => {
				logger.trace(`Error occurred in ${eventName}`);
				try {
					logger.trace(JSON.stringify(e));
				} catch (e) {
					logger.trace("Unable to print error message.");
				}
				inProgressEvent?.end({ success: false }, e);
				throw e;
			});
		};
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	var RegionDiscovery = class RegionDiscovery {
		constructor(networkInterface, logger, performanceClient, correlationId) {
			this.networkInterface = networkInterface;
			this.logger = logger;
			this.performanceClient = performanceClient;
			this.correlationId = correlationId;
		}
		/**
		* Detect the region from the application's environment.
		*
		* @returns Promise<string | null>
		*/
		async detectRegion(environmentRegion, regionDiscoveryMetadata) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryDetectRegion, this.correlationId);
			let autodetectedRegionName = environmentRegion;
			if (!autodetectedRegionName) {
				const options = RegionDiscovery.IMDS_OPTIONS;
				try {
					const localIMDSVersionResponse = await invokeAsync(this.getRegionFromIMDS.bind(this), PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.logger, this.performanceClient, this.correlationId)(Constants$1.IMDS_VERSION, options);
					if (localIMDSVersionResponse.status === HttpStatus.SUCCESS) {
						autodetectedRegionName = localIMDSVersionResponse.body;
						regionDiscoveryMetadata.region_source = RegionDiscoverySources.IMDS;
					}
					if (localIMDSVersionResponse.status === HttpStatus.BAD_REQUEST) {
						const currentIMDSVersion = await invokeAsync(this.getCurrentVersion.bind(this), PerformanceEvents.RegionDiscoveryGetCurrentVersion, this.logger, this.performanceClient, this.correlationId)(options);
						if (!currentIMDSVersion) {
							regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
							return null;
						}
						const currentIMDSVersionResponse = await invokeAsync(this.getRegionFromIMDS.bind(this), PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.logger, this.performanceClient, this.correlationId)(currentIMDSVersion, options);
						if (currentIMDSVersionResponse.status === HttpStatus.SUCCESS) {
							autodetectedRegionName = currentIMDSVersionResponse.body;
							regionDiscoveryMetadata.region_source = RegionDiscoverySources.IMDS;
						}
					}
				} catch (e) {
					regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
					return null;
				}
			} else regionDiscoveryMetadata.region_source = RegionDiscoverySources.ENVIRONMENT_VARIABLE;
			if (!autodetectedRegionName) regionDiscoveryMetadata.region_source = RegionDiscoverySources.FAILED_AUTO_DETECTION;
			return autodetectedRegionName || null;
		}
		/**
		* Make the call to the IMDS endpoint
		*
		* @param imdsEndpointUrl
		* @returns Promise<NetworkResponse<string>>
		*/
		async getRegionFromIMDS(version, options) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryGetRegionFromIMDS, this.correlationId);
			return this.networkInterface.sendGetRequestAsync(`${Constants$1.IMDS_ENDPOINT}?api-version=${version}&format=text`, options, Constants$1.IMDS_TIMEOUT);
		}
		/**
		* Get the most recent version of the IMDS endpoint available
		*
		* @returns Promise<string | null>
		*/
		async getCurrentVersion(options) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RegionDiscoveryGetCurrentVersion, this.correlationId);
			try {
				const response = await this.networkInterface.sendGetRequestAsync(`${Constants$1.IMDS_ENDPOINT}?format=json`, options);
				if (response.status === HttpStatus.BAD_REQUEST && response.body && response.body["newest-versions"] && response.body["newest-versions"].length > 0) return response.body["newest-versions"][0];
				return null;
			} catch (e) {
				return null;
			}
		}
	};
	RegionDiscovery.IMDS_OPTIONS = { headers: { Metadata: "true" } };
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Utility functions for managing date and time operations.
	*/
	/**
	* return the current time in Unix time (seconds).
	*/
	function nowSeconds() {
		return Math.round((/* @__PURE__ */ new Date()).getTime() / 1e3);
	}
	/**
	* Convert seconds to JS Date object. Seconds can be in a number or string format or undefined (will still return a date).
	* @param seconds
	*/
	function toDateFromSeconds(seconds) {
		if (seconds) return /* @__PURE__ */ new Date(Number(seconds) * 1e3);
		return /* @__PURE__ */ new Date();
	}
	/**
	* check if a token is expired based on given UTC time in seconds.
	* @param expiresOn
	*/
	function isTokenExpired(expiresOn, offset) {
		const expirationSec = Number(expiresOn) || 0;
		return nowSeconds() + offset > expirationSec;
	}
	/**
	* If the current time is earlier than the time that a token was cached at, we must discard the token
	* i.e. The system clock was turned back after acquiring the cached token
	* @param cachedAt
	* @param offset
	*/
	function wasClockTurnedBack(cachedAt) {
		return Number(cachedAt) > nowSeconds();
	}
	/**
	* Waits for t number of milliseconds
	* @param t number
	* @param value T
	*/
	function delay(t, value) {
		return new Promise((resolve) => setTimeout(() => resolve(value), t));
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Create IdTokenEntity
	* @param homeAccountId
	* @param authenticationResult
	* @param clientId
	* @param authority
	*/
	function createIdTokenEntity(homeAccountId, environment, idToken, clientId, tenantId) {
		return {
			credentialType: CredentialType.ID_TOKEN,
			homeAccountId,
			environment,
			clientId,
			secret: idToken,
			realm: tenantId,
			lastUpdatedAt: Date.now().toString()
		};
	}
	/**
	* Create AccessTokenEntity
	* @param homeAccountId
	* @param environment
	* @param accessToken
	* @param clientId
	* @param tenantId
	* @param scopes
	* @param expiresOn
	* @param extExpiresOn
	*/
	function createAccessTokenEntity(homeAccountId, environment, accessToken, clientId, tenantId, scopes, expiresOn, extExpiresOn, base64Decode, refreshOn, tokenType, userAssertionHash, keyId, requestedClaims, requestedClaimsHash) {
		const atEntity = {
			homeAccountId,
			credentialType: CredentialType.ACCESS_TOKEN,
			secret: accessToken,
			cachedAt: nowSeconds().toString(),
			expiresOn: expiresOn.toString(),
			extendedExpiresOn: extExpiresOn.toString(),
			environment,
			clientId,
			realm: tenantId,
			target: scopes,
			tokenType: tokenType || AuthenticationScheme.BEARER,
			lastUpdatedAt: Date.now().toString()
		};
		if (userAssertionHash) atEntity.userAssertionHash = userAssertionHash;
		if (refreshOn) atEntity.refreshOn = refreshOn.toString();
		if (requestedClaims) {
			atEntity.requestedClaims = requestedClaims;
			atEntity.requestedClaimsHash = requestedClaimsHash;
		}
		if (atEntity.tokenType?.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase()) {
			atEntity.credentialType = CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME;
			switch (atEntity.tokenType) {
				case AuthenticationScheme.POP:
					const tokenClaims = extractTokenClaims(accessToken, base64Decode);
					if (!tokenClaims?.cnf?.kid) throw createClientAuthError(tokenClaimsCnfRequiredForSignedJwt);
					atEntity.keyId = tokenClaims.cnf.kid;
					break;
				case AuthenticationScheme.SSH: atEntity.keyId = keyId;
			}
		}
		return atEntity;
	}
	/**
	* Create RefreshTokenEntity
	* @param homeAccountId
	* @param authenticationResult
	* @param clientId
	* @param authority
	*/
	function createRefreshTokenEntity(homeAccountId, environment, refreshToken, clientId, familyId, userAssertionHash, expiresOn) {
		const rtEntity = {
			credentialType: CredentialType.REFRESH_TOKEN,
			homeAccountId,
			environment,
			clientId,
			secret: refreshToken,
			lastUpdatedAt: Date.now().toString()
		};
		if (userAssertionHash) rtEntity.userAssertionHash = userAssertionHash;
		if (familyId) rtEntity.familyId = familyId;
		if (expiresOn) rtEntity.expiresOn = expiresOn.toString();
		return rtEntity;
	}
	function isCredentialEntity(entity) {
		return entity.hasOwnProperty("homeAccountId") && entity.hasOwnProperty("environment") && entity.hasOwnProperty("credentialType") && entity.hasOwnProperty("clientId") && entity.hasOwnProperty("secret");
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isAccessTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity.hasOwnProperty("realm") && entity.hasOwnProperty("target") && (entity["credentialType"] === CredentialType.ACCESS_TOKEN || entity["credentialType"] === CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME);
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isIdTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity.hasOwnProperty("realm") && entity["credentialType"] === CredentialType.ID_TOKEN;
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isRefreshTokenEntity(entity) {
		if (!entity) return false;
		return isCredentialEntity(entity) && entity["credentialType"] === CredentialType.REFRESH_TOKEN;
	}
	/**
	* validates if a given cache entry is "Telemetry", parses <key,value>
	* @param key
	* @param entity
	*/
	function isServerTelemetryEntity(key, entity) {
		const validateKey = key.indexOf(SERVER_TELEM_CONSTANTS.CACHE_KEY) === 0;
		let validateEntity = true;
		if (entity) validateEntity = entity.hasOwnProperty("failedRequests") && entity.hasOwnProperty("errors") && entity.hasOwnProperty("cacheHits");
		return validateKey && validateEntity;
	}
	/**
	* validates if a given cache entry is "Throttling", parses <key,value>
	* @param key
	* @param entity
	*/
	function isThrottlingEntity(key, entity) {
		let validateKey = false;
		if (key) validateKey = key.indexOf(ThrottlingConstants.THROTTLING_PREFIX) === 0;
		let validateEntity = true;
		if (entity) validateEntity = entity.hasOwnProperty("throttleTime");
		return validateKey && validateEntity;
	}
	/**
	* Generate AppMetadata Cache Key as per the schema: appmetadata-<environment>-<client_id>
	*/
	function generateAppMetadataKey({ environment, clientId }) {
		return [
			APP_METADATA,
			environment,
			clientId
		].join(Separators.CACHE_KEY_SEPARATOR).toLowerCase();
	}
	function isAppMetadataEntity(key, entity) {
		if (!entity) return false;
		return key.indexOf(APP_METADATA) === 0 && entity.hasOwnProperty("clientId") && entity.hasOwnProperty("environment");
	}
	/**
	* Validates an entity: checks for all expected params
	* @param entity
	*/
	function isAuthorityMetadataEntity(key, entity) {
		if (!entity) return false;
		return key.indexOf(AUTHORITY_METADATA_CONSTANTS.CACHE_KEY) === 0 && entity.hasOwnProperty("aliases") && entity.hasOwnProperty("preferred_cache") && entity.hasOwnProperty("preferred_network") && entity.hasOwnProperty("canonical_authority") && entity.hasOwnProperty("authorization_endpoint") && entity.hasOwnProperty("token_endpoint") && entity.hasOwnProperty("issuer") && entity.hasOwnProperty("aliasesFromNetwork") && entity.hasOwnProperty("endpointsFromNetwork") && entity.hasOwnProperty("expiresAt") && entity.hasOwnProperty("jwks_uri");
	}
	/**
	* Reset the exiresAt value
	*/
	function generateAuthorityMetadataExpiresAt() {
		return nowSeconds() + AUTHORITY_METADATA_CONSTANTS.REFRESH_TIME_SECONDS;
	}
	function updateAuthorityEndpointMetadata(authorityMetadata, updatedValues, fromNetwork) {
		authorityMetadata.authorization_endpoint = updatedValues.authorization_endpoint;
		authorityMetadata.token_endpoint = updatedValues.token_endpoint;
		authorityMetadata.end_session_endpoint = updatedValues.end_session_endpoint;
		authorityMetadata.issuer = updatedValues.issuer;
		authorityMetadata.endpointsFromNetwork = fromNetwork;
		authorityMetadata.jwks_uri = updatedValues.jwks_uri;
	}
	function updateCloudDiscoveryMetadata(authorityMetadata, updatedValues, fromNetwork) {
		authorityMetadata.aliases = updatedValues.aliases;
		authorityMetadata.preferred_cache = updatedValues.preferred_cache;
		authorityMetadata.preferred_network = updatedValues.preferred_network;
		authorityMetadata.aliasesFromNetwork = fromNetwork;
	}
	/**
	* Returns whether or not the data needs to be refreshed
	*/
	function isAuthorityMetadataExpired(metadata) {
		return metadata.expiresAt <= nowSeconds();
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* The authority class validates the authority URIs used by the user, and retrieves the OpenID Configuration Data from the
	* endpoint. It will store the pertinent config data in this object for use during token calls.
	* @internal
	*/
	var Authority = class Authority {
		constructor(authority, networkInterface, cacheManager, authorityOptions, logger, correlationId, performanceClient, managedIdentity) {
			this.canonicalAuthority = authority;
			this._canonicalAuthority.validateAsUri();
			this.networkInterface = networkInterface;
			this.cacheManager = cacheManager;
			this.authorityOptions = authorityOptions;
			this.regionDiscoveryMetadata = {
				region_used: void 0,
				region_source: void 0,
				region_outcome: void 0
			};
			this.logger = logger;
			this.performanceClient = performanceClient;
			this.correlationId = correlationId;
			this.managedIdentity = managedIdentity || false;
			this.regionDiscovery = new RegionDiscovery(networkInterface, this.logger, this.performanceClient, this.correlationId);
		}
		/**
		* Get {@link AuthorityType}
		* @param authorityUri {@link IUri}
		* @private
		*/
		getAuthorityType(authorityUri) {
			if (authorityUri.HostNameAndPort.endsWith(Constants$1.CIAM_AUTH_URL)) return AuthorityType.Ciam;
			const pathSegments = authorityUri.PathSegments;
			if (pathSegments.length) switch (pathSegments[0].toLowerCase()) {
				case Constants$1.ADFS: return AuthorityType.Adfs;
				case Constants$1.DSTS: return AuthorityType.Dsts;
			}
			return AuthorityType.Default;
		}
		get authorityType() {
			return this.getAuthorityType(this.canonicalAuthorityUrlComponents);
		}
		/**
		* ProtocolMode enum representing the way endpoints are constructed.
		*/
		get protocolMode() {
			return this.authorityOptions.protocolMode;
		}
		/**
		* Returns authorityOptions which can be used to reinstantiate a new authority instance
		*/
		get options() {
			return this.authorityOptions;
		}
		/**
		* A URL that is the authority set by the developer
		*/
		get canonicalAuthority() {
			return this._canonicalAuthority.urlString;
		}
		/**
		* Sets canonical authority.
		*/
		set canonicalAuthority(url) {
			this._canonicalAuthority = new UrlString(url);
			this._canonicalAuthority.validateAsUri();
			this._canonicalAuthorityUrlComponents = null;
		}
		/**
		* Get authority components.
		*/
		get canonicalAuthorityUrlComponents() {
			if (!this._canonicalAuthorityUrlComponents) this._canonicalAuthorityUrlComponents = this._canonicalAuthority.getUrlComponents();
			return this._canonicalAuthorityUrlComponents;
		}
		/**
		* Get hostname and port i.e. login.microsoftonline.com
		*/
		get hostnameAndPort() {
			return this.canonicalAuthorityUrlComponents.HostNameAndPort.toLowerCase();
		}
		/**
		* Get tenant for authority.
		*/
		get tenant() {
			return this.canonicalAuthorityUrlComponents.PathSegments[0];
		}
		/**
		* OAuth /authorize endpoint for requests
		*/
		get authorizationEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.authorization_endpoint);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth /token endpoint for requests
		*/
		get tokenEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.token_endpoint);
			else throw createClientAuthError(endpointResolutionError);
		}
		get deviceCodeEndpoint() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.token_endpoint.replace("/token", "/devicecode"));
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth logout endpoint for requests
		*/
		get endSessionEndpoint() {
			if (this.discoveryComplete()) {
				if (!this.metadata.end_session_endpoint) throw createClientAuthError(endSessionEndpointNotSupported);
				return this.replacePath(this.metadata.end_session_endpoint);
			} else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* OAuth issuer for requests
		*/
		get selfSignedJwtAudience() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.issuer);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Jwks_uri for token signing keys
		*/
		get jwksUri() {
			if (this.discoveryComplete()) return this.replacePath(this.metadata.jwks_uri);
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Returns a flag indicating that tenant name can be replaced in authority {@link IUri}
		* @param authorityUri {@link IUri}
		* @private
		*/
		canReplaceTenant(authorityUri) {
			return authorityUri.PathSegments.length === 1 && !Authority.reservedTenantDomains.has(authorityUri.PathSegments[0]) && this.getAuthorityType(authorityUri) === AuthorityType.Default && this.protocolMode !== ProtocolMode.OIDC;
		}
		/**
		* Replaces tenant in url path with current tenant. Defaults to common.
		* @param urlString
		*/
		replaceTenant(urlString) {
			return urlString.replace(/{tenant}|{tenantid}/g, this.tenant);
		}
		/**
		* Replaces path such as tenant or policy with the current tenant or policy.
		* @param urlString
		*/
		replacePath(urlString) {
			let endpoint = urlString;
			const cachedAuthorityUrlComponents = new UrlString(this.metadata.canonical_authority).getUrlComponents();
			const cachedAuthorityParts = cachedAuthorityUrlComponents.PathSegments;
			this.canonicalAuthorityUrlComponents.PathSegments.forEach((currentPart, index) => {
				let cachedPart = cachedAuthorityParts[index];
				if (index === 0 && this.canReplaceTenant(cachedAuthorityUrlComponents)) {
					const tenantId = new UrlString(this.metadata.authorization_endpoint).getUrlComponents().PathSegments[0];
					/**
					* Check if AAD canonical authority contains tenant domain name, for example "testdomain.onmicrosoft.com",
					* by comparing its first path segment to the corresponding authorization endpoint path segment, which is
					* always resolved with tenant id by OIDC.
					*/
					if (cachedPart !== tenantId) {
						this.logger.verbose(`Replacing tenant domain name ${cachedPart} with id ${tenantId}`);
						cachedPart = tenantId;
					}
				}
				if (currentPart !== cachedPart) endpoint = endpoint.replace(`/${cachedPart}/`, `/${currentPart}/`);
			});
			return this.replaceTenant(endpoint);
		}
		/**
		* The default open id configuration endpoint for any canonical authority.
		*/
		get defaultOpenIdConfigurationEndpoint() {
			const canonicalAuthorityHost = this.hostnameAndPort;
			if (this.canonicalAuthority.endsWith("v2.0/") || this.authorityType === AuthorityType.Adfs || this.protocolMode === ProtocolMode.OIDC && !this.isAliasOfKnownMicrosoftAuthority(canonicalAuthorityHost)) return `${this.canonicalAuthority}.well-known/openid-configuration`;
			return `${this.canonicalAuthority}v2.0/.well-known/openid-configuration`;
		}
		/**
		* Boolean that returns whether or not tenant discovery has been completed.
		*/
		discoveryComplete() {
			return !!this.metadata;
		}
		/**
		* Perform endpoint discovery to discover aliases, preferred_cache, preferred_network
		* and the /authorize, /token and logout endpoints.
		*/
		async resolveEndpointsAsync() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityResolveEndpointsAsync, this.correlationId);
			const metadataEntity = this.getCurrentMetadataEntity();
			const cloudDiscoverySource = await invokeAsync(this.updateCloudDiscoveryMetadata.bind(this), PerformanceEvents.AuthorityUpdateCloudDiscoveryMetadata, this.logger, this.performanceClient, this.correlationId)(metadataEntity);
			this.canonicalAuthority = this.canonicalAuthority.replace(this.hostnameAndPort, metadataEntity.preferred_network);
			const endpointSource = await invokeAsync(this.updateEndpointMetadata.bind(this), PerformanceEvents.AuthorityUpdateEndpointMetadata, this.logger, this.performanceClient, this.correlationId)(metadataEntity);
			this.updateCachedMetadata(metadataEntity, cloudDiscoverySource, { source: endpointSource });
			this.performanceClient?.addFields({
				cloudDiscoverySource,
				authorityEndpointSource: endpointSource
			}, this.correlationId);
		}
		/**
		* Returns metadata entity from cache if it exists, otherwiser returns a new metadata entity built
		* from the configured canonical authority
		* @returns
		*/
		getCurrentMetadataEntity() {
			let metadataEntity = this.cacheManager.getAuthorityMetadataByAlias(this.hostnameAndPort);
			if (!metadataEntity) metadataEntity = {
				aliases: [],
				preferred_cache: this.hostnameAndPort,
				preferred_network: this.hostnameAndPort,
				canonical_authority: this.canonicalAuthority,
				authorization_endpoint: "",
				token_endpoint: "",
				end_session_endpoint: "",
				issuer: "",
				aliasesFromNetwork: false,
				endpointsFromNetwork: false,
				expiresAt: generateAuthorityMetadataExpiresAt(),
				jwks_uri: ""
			};
			return metadataEntity;
		}
		/**
		* Updates cached metadata based on metadata source and sets the instance's metadata
		* property to the same value
		* @param metadataEntity
		* @param cloudDiscoverySource
		* @param endpointMetadataResult
		*/
		updateCachedMetadata(metadataEntity, cloudDiscoverySource, endpointMetadataResult) {
			if (cloudDiscoverySource !== AuthorityMetadataSource.CACHE && endpointMetadataResult?.source !== AuthorityMetadataSource.CACHE) {
				metadataEntity.expiresAt = generateAuthorityMetadataExpiresAt();
				metadataEntity.canonical_authority = this.canonicalAuthority;
			}
			const cacheKey = this.cacheManager.generateAuthorityMetadataCacheKey(metadataEntity.preferred_cache);
			this.cacheManager.setAuthorityMetadata(cacheKey, metadataEntity);
			this.metadata = metadataEntity;
		}
		/**
		* Update AuthorityMetadataEntity with new endpoints and return where the information came from
		* @param metadataEntity
		*/
		async updateEndpointMetadata(metadataEntity) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateEndpointMetadata, this.correlationId);
			const localMetadata = this.updateEndpointMetadataFromLocalSources(metadataEntity);
			if (localMetadata) {
				if (localMetadata.source === AuthorityMetadataSource.HARDCODED_VALUES) {
					if (this.authorityOptions.azureRegionConfiguration?.azureRegion) {
						if (localMetadata.metadata) {
							updateAuthorityEndpointMetadata(metadataEntity, await invokeAsync(this.updateMetadataWithRegionalInformation.bind(this), PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.logger, this.performanceClient, this.correlationId)(localMetadata.metadata), false);
							metadataEntity.canonical_authority = this.canonicalAuthority;
						}
					}
				}
				return localMetadata.source;
			}
			let metadata = await invokeAsync(this.getEndpointMetadataFromNetwork.bind(this), PerformanceEvents.AuthorityGetEndpointMetadataFromNetwork, this.logger, this.performanceClient, this.correlationId)();
			if (metadata) {
				if (this.authorityOptions.azureRegionConfiguration?.azureRegion) metadata = await invokeAsync(this.updateMetadataWithRegionalInformation.bind(this), PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.logger, this.performanceClient, this.correlationId)(metadata);
				updateAuthorityEndpointMetadata(metadataEntity, metadata, true);
				return AuthorityMetadataSource.NETWORK;
			} else throw createClientAuthError(openIdConfigError, this.defaultOpenIdConfigurationEndpoint);
		}
		/**
		* Updates endpoint metadata from local sources and returns where the information was retrieved from and the metadata config
		* response if the source is hardcoded metadata
		* @param metadataEntity
		* @returns
		*/
		updateEndpointMetadataFromLocalSources(metadataEntity) {
			this.logger.verbose("Attempting to get endpoint metadata from authority configuration");
			const configMetadata = this.getEndpointMetadataFromConfig();
			if (configMetadata) {
				this.logger.verbose("Found endpoint metadata in authority configuration");
				updateAuthorityEndpointMetadata(metadataEntity, configMetadata, false);
				return { source: AuthorityMetadataSource.CONFIG };
			}
			this.logger.verbose("Did not find endpoint metadata in the config... Attempting to get endpoint metadata from the hardcoded values.");
			if (this.authorityOptions.skipAuthorityMetadataCache) this.logger.verbose("Skipping hardcoded metadata cache since skipAuthorityMetadataCache is set to true. Attempting to get endpoint metadata from the network metadata cache.");
			else {
				const hardcodedMetadata = this.getEndpointMetadataFromHardcodedValues();
				if (hardcodedMetadata) {
					updateAuthorityEndpointMetadata(metadataEntity, hardcodedMetadata, false);
					return {
						source: AuthorityMetadataSource.HARDCODED_VALUES,
						metadata: hardcodedMetadata
					};
				} else this.logger.verbose("Did not find endpoint metadata in hardcoded values... Attempting to get endpoint metadata from the network metadata cache.");
			}
			const metadataEntityExpired = isAuthorityMetadataExpired(metadataEntity);
			if (this.isAuthoritySameType(metadataEntity) && metadataEntity.endpointsFromNetwork && !metadataEntityExpired) {
				this.logger.verbose("Found endpoint metadata in the cache.");
				return { source: AuthorityMetadataSource.CACHE };
			} else if (metadataEntityExpired) this.logger.verbose("The metadata entity is expired.");
			return null;
		}
		/**
		* Compares the number of url components after the domain to determine if the cached
		* authority metadata can be used for the requested authority. Protects against same domain different
		* authority such as login.microsoftonline.com/tenant and login.microsoftonline.com/tfp/tenant/policy
		* @param metadataEntity
		*/
		isAuthoritySameType(metadataEntity) {
			return new UrlString(metadataEntity.canonical_authority).getUrlComponents().PathSegments.length === this.canonicalAuthorityUrlComponents.PathSegments.length;
		}
		/**
		* Parse authorityMetadata config option
		*/
		getEndpointMetadataFromConfig() {
			if (this.authorityOptions.authorityMetadata) try {
				return JSON.parse(this.authorityOptions.authorityMetadata);
			} catch (e) {
				throw createClientConfigurationError(invalidAuthorityMetadata);
			}
			return null;
		}
		/**
		* Gets OAuth endpoints from the given OpenID configuration endpoint.
		*
		* @param hasHardcodedMetadata boolean
		*/
		async getEndpointMetadataFromNetwork() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityGetEndpointMetadataFromNetwork, this.correlationId);
			const options = {};
			const openIdConfigurationEndpoint = this.defaultOpenIdConfigurationEndpoint;
			this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: attempting to retrieve OAuth endpoints from ${openIdConfigurationEndpoint}`);
			try {
				const response = await this.networkInterface.sendGetRequestAsync(openIdConfigurationEndpoint, options);
				if (isOpenIdConfigResponse(response.body)) return response.body;
				else {
					this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: could not parse response as OpenID configuration`);
					return null;
				}
			} catch (e) {
				this.logger.verbose(`Authority.getEndpointMetadataFromNetwork: ${e}`);
				return null;
			}
		}
		/**
		* Get OAuth endpoints for common authorities.
		*/
		getEndpointMetadataFromHardcodedValues() {
			if (this.hostnameAndPort in EndpointMetadata) return EndpointMetadata[this.hostnameAndPort];
			return null;
		}
		/**
		* Update the retrieved metadata with regional information.
		* User selected Azure region will be used if configured.
		*/
		async updateMetadataWithRegionalInformation(metadata) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateMetadataWithRegionalInformation, this.correlationId);
			const userConfiguredAzureRegion = this.authorityOptions.azureRegionConfiguration?.azureRegion;
			if (userConfiguredAzureRegion) {
				if (userConfiguredAzureRegion !== Constants$1.AZURE_REGION_AUTO_DISCOVER_FLAG) {
					this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.CONFIGURED_NO_AUTO_DETECTION;
					this.regionDiscoveryMetadata.region_used = userConfiguredAzureRegion;
					return Authority.replaceWithRegionalInformation(metadata, userConfiguredAzureRegion);
				}
				const autodetectedRegionName = await invokeAsync(this.regionDiscovery.detectRegion.bind(this.regionDiscovery), PerformanceEvents.RegionDiscoveryDetectRegion, this.logger, this.performanceClient, this.correlationId)(this.authorityOptions.azureRegionConfiguration?.environmentRegion, this.regionDiscoveryMetadata);
				if (autodetectedRegionName) {
					this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.AUTO_DETECTION_REQUESTED_SUCCESSFUL;
					this.regionDiscoveryMetadata.region_used = autodetectedRegionName;
					return Authority.replaceWithRegionalInformation(metadata, autodetectedRegionName);
				}
				this.regionDiscoveryMetadata.region_outcome = RegionDiscoveryOutcomes.AUTO_DETECTION_REQUESTED_FAILED;
			}
			return metadata;
		}
		/**
		* Updates the AuthorityMetadataEntity with new aliases, preferred_network and preferred_cache
		* and returns where the information was retrieved from
		* @param metadataEntity
		* @returns AuthorityMetadataSource
		*/
		async updateCloudDiscoveryMetadata(metadataEntity) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityUpdateCloudDiscoveryMetadata, this.correlationId);
			const localMetadataSource = this.updateCloudDiscoveryMetadataFromLocalSources(metadataEntity);
			if (localMetadataSource) return localMetadataSource;
			const metadata = await invokeAsync(this.getCloudDiscoveryMetadataFromNetwork.bind(this), PerformanceEvents.AuthorityGetCloudDiscoveryMetadataFromNetwork, this.logger, this.performanceClient, this.correlationId)();
			if (metadata) {
				updateCloudDiscoveryMetadata(metadataEntity, metadata, true);
				return AuthorityMetadataSource.NETWORK;
			}
			throw createClientConfigurationError(untrustedAuthority);
		}
		updateCloudDiscoveryMetadataFromLocalSources(metadataEntity) {
			this.logger.verbose("Attempting to get cloud discovery metadata  from authority configuration");
			this.logger.verbosePii(`Known Authorities: ${this.authorityOptions.knownAuthorities || Constants$1.NOT_APPLICABLE}`);
			this.logger.verbosePii(`Authority Metadata: ${this.authorityOptions.authorityMetadata || Constants$1.NOT_APPLICABLE}`);
			this.logger.verbosePii(`Canonical Authority: ${metadataEntity.canonical_authority || Constants$1.NOT_APPLICABLE}`);
			const metadata = this.getCloudDiscoveryMetadataFromConfig();
			if (metadata) {
				this.logger.verbose("Found cloud discovery metadata in authority configuration");
				updateCloudDiscoveryMetadata(metadataEntity, metadata, false);
				return AuthorityMetadataSource.CONFIG;
			}
			this.logger.verbose("Did not find cloud discovery metadata in the config... Attempting to get cloud discovery metadata from the hardcoded values.");
			if (this.options.skipAuthorityMetadataCache) this.logger.verbose("Skipping hardcoded cloud discovery metadata cache since skipAuthorityMetadataCache is set to true. Attempting to get cloud discovery metadata from the network metadata cache.");
			else {
				const hardcodedMetadata = getCloudDiscoveryMetadataFromHardcodedValues(this.hostnameAndPort);
				if (hardcodedMetadata) {
					this.logger.verbose("Found cloud discovery metadata from hardcoded values.");
					updateCloudDiscoveryMetadata(metadataEntity, hardcodedMetadata, false);
					return AuthorityMetadataSource.HARDCODED_VALUES;
				}
				this.logger.verbose("Did not find cloud discovery metadata in hardcoded values... Attempting to get cloud discovery metadata from the network metadata cache.");
			}
			const metadataEntityExpired = isAuthorityMetadataExpired(metadataEntity);
			if (this.isAuthoritySameType(metadataEntity) && metadataEntity.aliasesFromNetwork && !metadataEntityExpired) {
				this.logger.verbose("Found cloud discovery metadata in the cache.");
				return AuthorityMetadataSource.CACHE;
			} else if (metadataEntityExpired) this.logger.verbose("The metadata entity is expired.");
			return null;
		}
		/**
		* Parse cloudDiscoveryMetadata config or check knownAuthorities
		*/
		getCloudDiscoveryMetadataFromConfig() {
			if (this.authorityType === AuthorityType.Ciam) {
				this.logger.verbose("CIAM authorities do not support cloud discovery metadata, generate the aliases from authority host.");
				return Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			if (this.authorityOptions.cloudDiscoveryMetadata) {
				this.logger.verbose("The cloud discovery metadata has been provided as a network response, in the config.");
				try {
					this.logger.verbose("Attempting to parse the cloud discovery metadata.");
					const metadata = getCloudDiscoveryMetadataFromNetworkResponse(JSON.parse(this.authorityOptions.cloudDiscoveryMetadata).metadata, this.hostnameAndPort);
					this.logger.verbose("Parsed the cloud discovery metadata.");
					if (metadata) {
						this.logger.verbose("There is returnable metadata attached to the parsed cloud discovery metadata.");
						return metadata;
					} else this.logger.verbose("There is no metadata attached to the parsed cloud discovery metadata.");
				} catch (e) {
					this.logger.verbose("Unable to parse the cloud discovery metadata. Throwing Invalid Cloud Discovery Metadata Error.");
					throw createClientConfigurationError(invalidCloudDiscoveryMetadata);
				}
			}
			if (this.isInKnownAuthorities()) {
				this.logger.verbose("The host is included in knownAuthorities. Creating new cloud discovery metadata from the host.");
				return Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			return null;
		}
		/**
		* Called to get metadata from network if CloudDiscoveryMetadata was not populated by config
		*
		* @param hasHardcodedMetadata boolean
		*/
		async getCloudDiscoveryMetadataFromNetwork() {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityGetCloudDiscoveryMetadataFromNetwork, this.correlationId);
			const instanceDiscoveryEndpoint = `${Constants$1.AAD_INSTANCE_DISCOVERY_ENDPT}${this.canonicalAuthority}oauth2/v2.0/authorize`;
			const options = {};
			let match = null;
			try {
				const response = await this.networkInterface.sendGetRequestAsync(instanceDiscoveryEndpoint, options);
				let typedResponseBody;
				let metadata;
				if (isCloudInstanceDiscoveryResponse(response.body)) {
					typedResponseBody = response.body;
					metadata = typedResponseBody.metadata;
					this.logger.verbosePii(`tenant_discovery_endpoint is: ${typedResponseBody.tenant_discovery_endpoint}`);
				} else if (isCloudInstanceDiscoveryErrorResponse(response.body)) {
					this.logger.warning(`A CloudInstanceDiscoveryErrorResponse was returned. The cloud instance discovery network request's status code is: ${response.status}`);
					typedResponseBody = response.body;
					if (typedResponseBody.error === Constants$1.INVALID_INSTANCE) {
						this.logger.error("The CloudInstanceDiscoveryErrorResponse error is invalid_instance.");
						return null;
					}
					this.logger.warning(`The CloudInstanceDiscoveryErrorResponse error is ${typedResponseBody.error}`);
					this.logger.warning(`The CloudInstanceDiscoveryErrorResponse error description is ${typedResponseBody.error_description}`);
					this.logger.warning("Setting the value of the CloudInstanceDiscoveryMetadata (returned from the network) to []");
					metadata = [];
				} else {
					this.logger.error("AAD did not return a CloudInstanceDiscoveryResponse or CloudInstanceDiscoveryErrorResponse");
					return null;
				}
				this.logger.verbose("Attempting to find a match between the developer's authority and the CloudInstanceDiscoveryMetadata returned from the network request.");
				match = getCloudDiscoveryMetadataFromNetworkResponse(metadata, this.hostnameAndPort);
			} catch (error) {
				if (error instanceof AuthError) this.logger.error(`There was a network error while attempting to get the cloud discovery instance metadata.\nError: ${error.errorCode}\nError Description: ${error.errorMessage}`);
				else {
					const typedError = error;
					this.logger.error(`A non-MSALJS error was thrown while attempting to get the cloud instance discovery metadata.\nError: ${typedError.name}\nError Description: ${typedError.message}`);
				}
				return null;
			}
			if (!match) {
				this.logger.warning("The developer's authority was not found within the CloudInstanceDiscoveryMetadata returned from the network request.");
				this.logger.verbose("Creating custom Authority for custom domain scenario.");
				match = Authority.createCloudDiscoveryMetadataFromHost(this.hostnameAndPort);
			}
			return match;
		}
		/**
		* Helper function to determine if this host is included in the knownAuthorities config option
		*/
		isInKnownAuthorities() {
			return this.authorityOptions.knownAuthorities.filter((authority) => {
				return authority && UrlString.getDomainFromUrl(authority).toLowerCase() === this.hostnameAndPort;
			}).length > 0;
		}
		/**
		* helper function to populate the authority based on azureCloudOptions
		* @param authorityString
		* @param azureCloudOptions
		*/
		static generateAuthority(authorityString, azureCloudOptions) {
			let authorityAzureCloudInstance;
			if (azureCloudOptions && azureCloudOptions.azureCloudInstance !== AzureCloudInstance.None) {
				const tenant = azureCloudOptions.tenant ? azureCloudOptions.tenant : Constants$1.DEFAULT_COMMON_TENANT;
				authorityAzureCloudInstance = `${azureCloudOptions.azureCloudInstance}/${tenant}/`;
			}
			return authorityAzureCloudInstance ? authorityAzureCloudInstance : authorityString;
		}
		/**
		* Creates cloud discovery metadata object from a given host
		* @param host
		*/
		static createCloudDiscoveryMetadataFromHost(host) {
			return {
				preferred_network: host,
				preferred_cache: host,
				aliases: [host]
			};
		}
		/**
		* helper function to generate environment from authority object
		*/
		getPreferredCache() {
			if (this.managedIdentity) return Constants$1.DEFAULT_AUTHORITY_HOST;
			else if (this.discoveryComplete()) return this.metadata.preferred_cache;
			else throw createClientAuthError(endpointResolutionError);
		}
		/**
		* Returns whether or not the provided host is an alias of this authority instance
		* @param host
		*/
		isAlias(host) {
			return this.metadata.aliases.indexOf(host) > -1;
		}
		/**
		* Returns whether or not the provided host is an alias of a known Microsoft authority for purposes of endpoint discovery
		* @param host
		*/
		isAliasOfKnownMicrosoftAuthority(host) {
			return InstanceDiscoveryMetadataAliases.has(host);
		}
		/**
		* Checks whether the provided host is that of a public cloud authority
		*
		* @param authority string
		* @returns bool
		*/
		static isPublicCloudAuthority(host) {
			return Constants$1.KNOWN_PUBLIC_CLOUDS.indexOf(host) >= 0;
		}
		/**
		* Rebuild the authority string with the region
		*
		* @param host string
		* @param region string
		*/
		static buildRegionalAuthorityString(host, region, queryString) {
			const authorityUrlInstance = new UrlString(host);
			authorityUrlInstance.validateAsUri();
			const authorityUrlParts = authorityUrlInstance.getUrlComponents();
			let hostNameAndPort = `${region}.${authorityUrlParts.HostNameAndPort}`;
			if (this.isPublicCloudAuthority(authorityUrlParts.HostNameAndPort)) hostNameAndPort = `${region}.${Constants$1.REGIONAL_AUTH_PUBLIC_CLOUD_SUFFIX}`;
			const url = UrlString.constructAuthorityUriFromObject({
				...authorityUrlInstance.getUrlComponents(),
				HostNameAndPort: hostNameAndPort
			}).urlString;
			if (queryString) return `${url}?${queryString}`;
			return url;
		}
		/**
		* Replace the endpoints in the metadata object with their regional equivalents.
		*
		* @param metadata OpenIdConfigResponse
		* @param azureRegion string
		*/
		static replaceWithRegionalInformation(metadata, azureRegion) {
			const regionalMetadata = { ...metadata };
			regionalMetadata.authorization_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.authorization_endpoint, azureRegion);
			regionalMetadata.token_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.token_endpoint, azureRegion);
			if (regionalMetadata.end_session_endpoint) regionalMetadata.end_session_endpoint = Authority.buildRegionalAuthorityString(regionalMetadata.end_session_endpoint, azureRegion);
			return regionalMetadata;
		}
		/**
		* Transform CIAM_AUTHORIY as per the below rules:
		* If no path segments found and it is a CIAM authority (hostname ends with .ciamlogin.com), then transform it
		*
		* NOTE: The transformation path should go away once STS supports CIAM with the format: `tenantIdorDomain.ciamlogin.com`
		* `ciamlogin.com` can also change in the future and we should accommodate the same
		*
		* @param authority
		*/
		static transformCIAMAuthority(authority) {
			let ciamAuthority = authority;
			const authorityUrlComponents = new UrlString(authority).getUrlComponents();
			if (authorityUrlComponents.PathSegments.length === 0 && authorityUrlComponents.HostNameAndPort.endsWith(Constants$1.CIAM_AUTH_URL)) {
				const tenantIdOrDomain = authorityUrlComponents.HostNameAndPort.split(".")[0];
				ciamAuthority = `${ciamAuthority}${tenantIdOrDomain}${Constants$1.AAD_TENANT_DOMAIN_SUFFIX}`;
			}
			return ciamAuthority;
		}
	};
	Authority.reservedTenantDomains = new Set([
		"{tenant}",
		"{tenantid}",
		AADAuthorityConstants.COMMON,
		AADAuthorityConstants.CONSUMERS,
		AADAuthorityConstants.ORGANIZATIONS
	]);
	/**
	* Extract tenantId from authority
	*/
	function getTenantFromAuthorityString(authority) {
		/**
		* For credential matching purposes, tenantId is the last path segment of the authority URL:
		*  AAD Authority - domain/tenantId -> Credentials are cached with realm = tenantId
		*  B2C Authority - domain/{tenantId}?/.../policy -> Credentials are cached with realm = policy
		*  tenantId is downcased because B2C policies can have mixed case but tfp claim is downcased
		*
		* Note that we may not have any path segments in certain OIDC scenarios.
		*/
		const tenantId = new UrlString(authority).getUrlComponents().PathSegments.slice(-1)[0]?.toLowerCase();
		switch (tenantId) {
			case AADAuthorityConstants.COMMON:
			case AADAuthorityConstants.ORGANIZATIONS:
			case AADAuthorityConstants.CONSUMERS: return;
			default: return tenantId;
		}
	}
	function formatAuthorityUri(authorityUri) {
		return authorityUri.endsWith(Constants$1.FORWARD_SLASH) ? authorityUri : `${authorityUri}${Constants$1.FORWARD_SLASH}`;
	}
	function buildStaticAuthorityOptions(authOptions) {
		const rawCloudDiscoveryMetadata = authOptions.cloudDiscoveryMetadata;
		let cloudDiscoveryMetadata = void 0;
		if (rawCloudDiscoveryMetadata) try {
			cloudDiscoveryMetadata = JSON.parse(rawCloudDiscoveryMetadata);
		} catch (e) {
			throw createClientConfigurationError(invalidCloudDiscoveryMetadata);
		}
		return {
			canonicalAuthority: authOptions.authority ? formatAuthorityUri(authOptions.authority) : void 0,
			knownAuthorities: authOptions.knownAuthorities,
			cloudDiscoveryMetadata
		};
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Create an authority object of the correct type based on the url
	* Performs basic authority validation - checks to see if the authority is of a valid type (i.e. aad, b2c, adfs)
	*
	* Also performs endpoint discovery.
	*
	* @param authorityUri
	* @param networkClient
	* @param protocolMode
	* @internal
	*/
	async function createDiscoveredInstance(authorityUri, networkClient, cacheManager, authorityOptions, logger, correlationId, performanceClient) {
		performanceClient?.addQueueMeasurement(PerformanceEvents.AuthorityFactoryCreateDiscoveredInstance, correlationId);
		const acquireTokenAuthority = new Authority(Authority.transformCIAMAuthority(formatAuthorityUri(authorityUri)), networkClient, cacheManager, authorityOptions, logger, correlationId, performanceClient);
		try {
			await invokeAsync(acquireTokenAuthority.resolveEndpointsAsync.bind(acquireTokenAuthority), PerformanceEvents.AuthorityResolveEndpointsAsync, logger, performanceClient, correlationId)();
			return acquireTokenAuthority;
		} catch (e) {
			throw createClientAuthError(endpointResolutionError);
		}
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Error thrown when there is an error with the server code, for example, unavailability.
	*/
	var ServerError = class ServerError extends AuthError {
		constructor(errorCode, errorMessage, subError, errorNo, status) {
			super(errorCode, errorMessage, subError);
			this.name = "ServerError";
			this.errorNo = errorNo;
			this.status = status;
			Object.setPrototypeOf(this, ServerError.prototype);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	function getRequestThumbprint(clientId, request, homeAccountId) {
		return {
			clientId,
			authority: request.authority,
			scopes: request.scopes,
			homeAccountIdentifier: homeAccountId,
			claims: request.claims,
			authenticationScheme: request.authenticationScheme,
			resourceRequestMethod: request.resourceRequestMethod,
			resourceRequestUri: request.resourceRequestUri,
			shrClaims: request.shrClaims,
			sshKid: request.sshKid,
			embeddedClientId: request.embeddedClientId || request.tokenBodyParameters?.clientId
		};
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/** @internal */
	var ThrottlingUtils = class ThrottlingUtils {
		/**
		* Prepares a RequestThumbprint to be stored as a key.
		* @param thumbprint
		*/
		static generateThrottlingStorageKey(thumbprint) {
			return `${ThrottlingConstants.THROTTLING_PREFIX}.${JSON.stringify(thumbprint)}`;
		}
		/**
		* Performs necessary throttling checks before a network request.
		* @param cacheManager
		* @param thumbprint
		*/
		static preProcess(cacheManager, thumbprint, correlationId) {
			const key = ThrottlingUtils.generateThrottlingStorageKey(thumbprint);
			const value = cacheManager.getThrottlingCache(key);
			if (value) {
				if (value.throttleTime < Date.now()) {
					cacheManager.removeItem(key, correlationId);
					return;
				}
				throw new ServerError(value.errorCodes?.join(" ") || Constants$1.EMPTY_STRING, value.errorMessage, value.subError);
			}
		}
		/**
		* Performs necessary throttling checks after a network request.
		* @param cacheManager
		* @param thumbprint
		* @param response
		*/
		static postProcess(cacheManager, thumbprint, response, correlationId) {
			if (ThrottlingUtils.checkResponseStatus(response) || ThrottlingUtils.checkResponseForRetryAfter(response)) {
				const thumbprintValue = {
					throttleTime: ThrottlingUtils.calculateThrottleTime(parseInt(response.headers[HeaderNames.RETRY_AFTER])),
					error: response.body.error,
					errorCodes: response.body.error_codes,
					errorMessage: response.body.error_description,
					subError: response.body.suberror
				};
				cacheManager.setThrottlingCache(ThrottlingUtils.generateThrottlingStorageKey(thumbprint), thumbprintValue, correlationId);
			}
		}
		/**
		* Checks a NetworkResponse object's status codes against 429 or 5xx
		* @param response
		*/
		static checkResponseStatus(response) {
			return response.status === 429 || response.status >= 500 && response.status < 600;
		}
		/**
		* Checks a NetworkResponse object's RetryAfter header
		* @param response
		*/
		static checkResponseForRetryAfter(response) {
			if (response.headers) return response.headers.hasOwnProperty(HeaderNames.RETRY_AFTER) && (response.status < 200 || response.status >= 300);
			return false;
		}
		/**
		* Calculates the Unix-time value for a throttle to expire given throttleTime in seconds.
		* @param throttleTime
		*/
		static calculateThrottleTime(throttleTime) {
			const time = throttleTime <= 0 ? 0 : throttleTime;
			const currentSeconds = Date.now() / 1e3;
			return Math.floor(Math.min(currentSeconds + (time || ThrottlingConstants.DEFAULT_THROTTLE_TIME_SECONDS), currentSeconds + ThrottlingConstants.DEFAULT_MAX_THROTTLE_TIME_SECONDS) * 1e3);
		}
		static removeThrottle(cacheManager, clientId, request, homeAccountIdentifier) {
			const thumbprint = getRequestThumbprint(clientId, request, homeAccountIdentifier);
			const key = this.generateThrottlingStorageKey(thumbprint);
			cacheManager.removeItem(key, request.correlationId);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Represents network related errors
	*/
	var NetworkError = class NetworkError extends AuthError {
		constructor(error, httpStatus, responseHeaders) {
			super(error.errorCode, error.errorMessage, error.subError);
			Object.setPrototypeOf(this, NetworkError.prototype);
			this.name = "NetworkError";
			this.error = error;
			this.httpStatus = httpStatus;
			this.responseHeaders = responseHeaders;
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Base application class which will construct requests to send to and handle responses from the Microsoft STS using the authorization code flow.
	* @internal
	*/
	var BaseClient = class {
		constructor(configuration, performanceClient) {
			this.config = buildClientConfiguration(configuration);
			this.logger = new Logger(this.config.loggerOptions, name$1, version$1);
			this.cryptoUtils = this.config.cryptoInterface;
			this.cacheManager = this.config.storageInterface;
			this.networkClient = this.config.networkInterface;
			this.serverTelemetryManager = this.config.serverTelemetryManager;
			this.authority = this.config.authOptions.authority;
			this.performanceClient = performanceClient;
		}
		/**
		* Creates default headers for requests to token endpoint
		*/
		createTokenRequestHeaders(ccsCred) {
			const headers = {};
			headers[HeaderNames.CONTENT_TYPE] = Constants$1.URL_FORM_CONTENT_TYPE;
			if (!this.config.systemOptions.preventCorsPreflight && ccsCred) switch (ccsCred.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						const clientInfo = buildClientInfoFromHomeAccountId(ccsCred.credential);
						headers[HeaderNames.CCS_HEADER] = `Oid:${clientInfo.uid}@${clientInfo.utid}`;
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					headers[HeaderNames.CCS_HEADER] = `UPN: ${ccsCred.credential}`;
					break;
			}
			return headers;
		}
		/**
		* Http post to token endpoint
		* @param tokenEndpoint
		* @param queryString
		* @param headers
		* @param thumbprint
		*/
		async executePostToTokenEndpoint(tokenEndpoint, queryString, headers, thumbprint, correlationId, queuedEvent) {
			if (queuedEvent) this.performanceClient?.addQueueMeasurement(queuedEvent, correlationId);
			const response = await this.sendPostRequest(thumbprint, tokenEndpoint, {
				body: queryString,
				headers
			}, correlationId);
			if (this.config.serverTelemetryManager && response.status < 500 && response.status !== 429) this.config.serverTelemetryManager.clearTelemetryCache();
			return response;
		}
		/**
		* Wraps sendPostRequestAsync with necessary preflight and postflight logic
		* @param thumbprint - Request thumbprint for throttling
		* @param tokenEndpoint - Endpoint to make the POST to
		* @param options - Body and Headers to include on the POST request
		* @param correlationId - CorrelationId for telemetry
		*/
		async sendPostRequest(thumbprint, tokenEndpoint, options, correlationId) {
			ThrottlingUtils.preProcess(this.cacheManager, thumbprint, correlationId);
			let response;
			try {
				response = await invokeAsync(this.networkClient.sendPostRequestAsync.bind(this.networkClient), PerformanceEvents.NetworkClientSendPostRequestAsync, this.logger, this.performanceClient, correlationId)(tokenEndpoint, options);
				const responseHeaders = response.headers || {};
				this.performanceClient?.addFields({
					refreshTokenSize: response.body.refresh_token?.length || 0,
					httpVerToken: responseHeaders[HeaderNames.X_MS_HTTP_VERSION] || "",
					requestId: responseHeaders[HeaderNames.X_MS_REQUEST_ID] || ""
				}, correlationId);
			} catch (e) {
				if (e instanceof NetworkError) {
					const responseHeaders = e.responseHeaders;
					if (responseHeaders) this.performanceClient?.addFields({
						httpVerToken: responseHeaders[HeaderNames.X_MS_HTTP_VERSION] || "",
						requestId: responseHeaders[HeaderNames.X_MS_REQUEST_ID] || "",
						contentTypeHeader: responseHeaders[HeaderNames.CONTENT_TYPE] || void 0,
						contentLengthHeader: responseHeaders[HeaderNames.CONTENT_LENGTH] || void 0,
						httpStatus: e.httpStatus
					}, correlationId);
					throw e.error;
				}
				if (e instanceof AuthError) throw e;
				else throw createClientAuthError(networkError);
			}
			ThrottlingUtils.postProcess(this.cacheManager, thumbprint, response, correlationId);
			return response;
		}
		/**
		* Updates the authority object of the client. Endpoint discovery must be completed.
		* @param updatedAuthority
		*/
		async updateAuthority(cloudInstanceHostname, correlationId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.UpdateTokenEndpointAuthority, correlationId);
			const cloudInstanceAuthority = await createDiscoveredInstance(`https://${cloudInstanceHostname}/${this.authority.tenant}/`, this.networkClient, this.cacheManager, this.authority.options, this.logger, correlationId, this.performanceClient);
			this.authority = cloudInstanceAuthority;
		}
		/**
		* Creates query string for the /token request
		* @param request
		*/
		createTokenQueryParameters(request) {
			const parameters = /* @__PURE__ */ new Map();
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenQueryParameters) addExtraQueryParameters(parameters, request.tokenQueryParameters);
			addCorrelationId(parameters, request.correlationId);
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			return mapToQueryString(parameters);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* MSAL-defined interaction required error code indicating no tokens are found in cache.
	* @public
	*/
	const noTokensFound = "no_tokens_found";
	/**
	* MSAL-defined error code indicating a native account is unavailable on the platform.
	* @public
	*/
	const nativeAccountUnavailable = "native_account_unavailable";
	/**
	* MSAL-defined error code indicating the refresh token has expired and user interaction is needed.
	* @public
	*/
	const refreshTokenExpired = "refresh_token_expired";
	/**
	* MSAL-defined error code indicating UI/UX is not allowed (e.g., blocked by policy), requiring alternate interaction.
	* @public
	*/
	const uxNotAllowed = "ux_not_allowed";
	/**
	* Server-originated error code indicating interaction is required to complete the request.
	* @public
	*/
	const interactionRequired = "interaction_required";
	/**
	* Server-originated error code indicating user consent is required.
	* @public
	*/
	const consentRequired = "consent_required";
	/**
	* Server-originated error code indicating user login is required.
	* @public
	*/
	const loginRequired = "login_required";
	/**
	* Server-originated error code indicating the token is invalid or corrupted.
	* @public
	*/
	const badToken = "bad_token";
	/**
	* Server-originated error code indicating the user was interrupted and must reattempt the flow.
	* @public
	*/
	const interruptedUser = "interrupted_user";
	var InteractionRequiredAuthErrorCodes = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		badToken,
		consentRequired,
		interactionRequired,
		interruptedUser,
		loginRequired,
		nativeAccountUnavailable,
		noTokensFound,
		refreshTokenExpired,
		uxNotAllowed
	});
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* InteractionRequiredServerErrorMessage contains string constants used by error codes and messages returned by the server indicating interaction is required
	*/
	const InteractionRequiredServerErrorMessage = [
		interactionRequired,
		consentRequired,
		loginRequired,
		badToken,
		uxNotAllowed,
		interruptedUser
	];
	const InteractionRequiredAuthSubErrorMessage = [
		"message_only",
		"additional_action",
		"basic_action",
		"user_password_expired",
		"consent_required",
		"bad_token",
		"interrupted_user"
	];
	const InteractionRequiredAuthErrorMessages = {
		[noTokensFound]: "No refresh token found in the cache. Please sign-in.",
		[nativeAccountUnavailable]: "The requested account is not available in the native broker. It may have been deleted or logged out. Please sign-in again using an interactive API.",
		[refreshTokenExpired]: "Refresh token has expired.",
		[badToken]: "Identity provider returned bad_token due to an expired or invalid refresh token. Please invoke an interactive API to resolve.",
		[uxNotAllowed]: "`canShowUI` flag in Edge was set to false. User interaction required on web page. Please invoke an interactive API to resolve.",
		[interruptedUser]: "The user could not be authenticated due to an interrupted state. Please invoke an interactive API to resolve."
	};
	/**
	* Interaction required errors defined by the SDK
	* @deprecated Use InteractionRequiredAuthErrorCodes instead
	*/
	const InteractionRequiredAuthErrorMessage = {
		noTokensFoundError: {
			code: noTokensFound,
			desc: InteractionRequiredAuthErrorMessages[noTokensFound]
		},
		native_account_unavailable: {
			code: nativeAccountUnavailable,
			desc: InteractionRequiredAuthErrorMessages[nativeAccountUnavailable]
		},
		bad_token: {
			code: badToken,
			desc: InteractionRequiredAuthErrorMessages[badToken]
		},
		interrupted_user: {
			code: interruptedUser,
			desc: InteractionRequiredAuthErrorMessages[interruptedUser]
		}
	};
	/**
	* Error thrown when user interaction is required.
	*/
	var InteractionRequiredAuthError = class InteractionRequiredAuthError extends AuthError {
		constructor(errorCode, errorMessage, subError, timestamp, traceId, correlationId, claims, errorNo) {
			super(errorCode, errorMessage, subError);
			Object.setPrototypeOf(this, InteractionRequiredAuthError.prototype);
			this.timestamp = timestamp || Constants$1.EMPTY_STRING;
			this.traceId = traceId || Constants$1.EMPTY_STRING;
			this.correlationId = correlationId || Constants$1.EMPTY_STRING;
			this.claims = claims || Constants$1.EMPTY_STRING;
			this.name = "InteractionRequiredAuthError";
			this.errorNo = errorNo;
		}
	};
	/**
	* Helper function used to determine if an error thrown by the server requires interaction to resolve
	* @param errorCode
	* @param errorString
	* @param subError
	*/
	function isInteractionRequiredError(errorCode, errorString, subError) {
		const isInteractionRequiredErrorCode = !!errorCode && InteractionRequiredServerErrorMessage.indexOf(errorCode) > -1;
		const isInteractionRequiredSubError = !!subError && InteractionRequiredAuthSubErrorMessage.indexOf(subError) > -1;
		const isInteractionRequiredErrorDesc = !!errorString && InteractionRequiredServerErrorMessage.some((irErrorCode) => {
			return errorString.indexOf(irErrorCode) > -1;
		});
		return isInteractionRequiredErrorCode || isInteractionRequiredErrorDesc || isInteractionRequiredSubError;
	}
	/**
	* Creates an InteractionRequiredAuthError
	*/
	function createInteractionRequiredAuthError(errorCode) {
		return new InteractionRequiredAuthError(errorCode, InteractionRequiredAuthErrorMessages[errorCode]);
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Class which provides helpers for OAuth 2.0 protocol specific values
	*/
	var ProtocolUtils = class ProtocolUtils {
		/**
		* Appends user state with random guid, or returns random guid.
		* @param userState
		* @param randomGuid
		*/
		static setRequestState(cryptoObj, userState, meta) {
			const libraryState = ProtocolUtils.generateLibraryState(cryptoObj, meta);
			return userState ? `${libraryState}${Constants$1.RESOURCE_DELIM}${userState}` : libraryState;
		}
		/**
		* Generates the state value used by the common library.
		* @param randomGuid
		* @param cryptoObj
		*/
		static generateLibraryState(cryptoObj, meta) {
			if (!cryptoObj) throw createClientAuthError(noCryptoObject);
			const stateObj = { id: cryptoObj.createNewGuid() };
			if (meta) stateObj.meta = meta;
			const stateString = JSON.stringify(stateObj);
			return cryptoObj.base64Encode(stateString);
		}
		/**
		* Parses the state into the RequestStateObject, which contains the LibraryState info and the state passed by the user.
		* @param state
		* @param cryptoObj
		*/
		static parseRequestState(cryptoObj, state) {
			if (!cryptoObj) throw createClientAuthError(noCryptoObject);
			if (!state) throw createClientAuthError(invalidState);
			try {
				const splitState = state.split(Constants$1.RESOURCE_DELIM);
				const libraryState = splitState[0];
				const userState = splitState.length > 1 ? splitState.slice(1).join(Constants$1.RESOURCE_DELIM) : Constants$1.EMPTY_STRING;
				const libraryStateString = cryptoObj.base64Decode(libraryState);
				const libraryStateObj = JSON.parse(libraryStateString);
				return {
					userRequestState: userState || Constants$1.EMPTY_STRING,
					libraryState: libraryStateObj
				};
			} catch (e) {
				throw createClientAuthError(invalidState);
			}
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const KeyLocation = { SW: "sw" };
	/** @internal */
	var PopTokenGenerator = class {
		constructor(cryptoUtils, performanceClient) {
			this.cryptoUtils = cryptoUtils;
			this.performanceClient = performanceClient;
		}
		/**
		* Generates the req_cnf validated at the RP in the POP protocol for SHR parameters
		* and returns an object containing the keyid, the full req_cnf string and the req_cnf string hash
		* @param request
		* @returns
		*/
		async generateCnf(request, logger) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.PopTokenGenerateCnf, request.correlationId);
			const reqCnf = await invokeAsync(this.generateKid.bind(this), PerformanceEvents.PopTokenGenerateCnf, logger, this.performanceClient, request.correlationId)(request);
			const reqCnfString = this.cryptoUtils.base64UrlEncode(JSON.stringify(reqCnf));
			return {
				kid: reqCnf.kid,
				reqCnfString
			};
		}
		/**
		* Generates key_id for a SHR token request
		* @param request
		* @returns
		*/
		async generateKid(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.PopTokenGenerateKid, request.correlationId);
			return {
				kid: await this.cryptoUtils.getPublicKeyThumbprint(request),
				xms_ksl: KeyLocation.SW
			};
		}
		/**
		* Signs the POP access_token with the local generated key-pair
		* @param accessToken
		* @param request
		* @returns
		*/
		async signPopToken(accessToken, keyId, request) {
			return this.signPayload(accessToken, keyId, request);
		}
		/**
		* Utility function to generate the signed JWT for an access_token
		* @param payload
		* @param kid
		* @param request
		* @param claims
		* @returns
		*/
		async signPayload(payload, keyId, request, claims) {
			const { resourceRequestMethod, resourceRequestUri, shrClaims, shrNonce, shrOptions } = request;
			const resourceUrlComponents = (resourceRequestUri ? new UrlString(resourceRequestUri) : void 0)?.getUrlComponents();
			return this.cryptoUtils.signJwt({
				at: payload,
				ts: nowSeconds(),
				m: resourceRequestMethod?.toUpperCase(),
				u: resourceUrlComponents?.HostNameAndPort,
				nonce: shrNonce || this.cryptoUtils.createNewGuid(),
				p: resourceUrlComponents?.AbsolutePath,
				q: resourceUrlComponents?.QueryString ? [[], resourceUrlComponents.QueryString] : void 0,
				client_claims: shrClaims || void 0,
				...claims
			}, keyId, shrOptions, request.correlationId);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* This class instance helps track the memory changes facilitating
	* decisions to read from and write to the persistent cache
	*/ var TokenCacheContext = class {
		constructor(tokenCache, hasChanged) {
			this.cache = tokenCache;
			this.hasChanged = hasChanged;
		}
		/**
		* boolean which indicates the changes in cache
		*/
		get cacheHasChanged() {
			return this.hasChanged;
		}
		/**
		* function to retrieve the token cache
		*/
		get tokenCache() {
			return this.cache;
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Class that handles response parsing.
	* @internal
	*/
	var ResponseHandler = class ResponseHandler {
		constructor(clientId, cacheStorage, cryptoObj, logger, serializableCache, persistencePlugin, performanceClient) {
			this.clientId = clientId;
			this.cacheStorage = cacheStorage;
			this.cryptoObj = cryptoObj;
			this.logger = logger;
			this.serializableCache = serializableCache;
			this.persistencePlugin = persistencePlugin;
			this.performanceClient = performanceClient;
		}
		/**
		* Function which validates server authorization token response.
		* @param serverResponse
		* @param refreshAccessToken
		*/
		validateTokenResponse(serverResponse, refreshAccessToken) {
			if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
				const errString = `Error(s): ${serverResponse.error_codes || Constants$1.NOT_AVAILABLE} - Timestamp: ${serverResponse.timestamp || Constants$1.NOT_AVAILABLE} - Description: ${serverResponse.error_description || Constants$1.NOT_AVAILABLE} - Correlation ID: ${serverResponse.correlation_id || Constants$1.NOT_AVAILABLE} - Trace ID: ${serverResponse.trace_id || Constants$1.NOT_AVAILABLE}`;
				const serverErrorNo = serverResponse.error_codes?.length ? serverResponse.error_codes[0] : void 0;
				const serverError = new ServerError(serverResponse.error, errString, serverResponse.suberror, serverErrorNo, serverResponse.status);
				if (refreshAccessToken && serverResponse.status && serverResponse.status >= HttpStatus.SERVER_ERROR_RANGE_START && serverResponse.status <= HttpStatus.SERVER_ERROR_RANGE_END) {
					this.logger.warning(`executeTokenRequest:validateTokenResponse - AAD is currently unavailable and the access token is unable to be refreshed.\n${serverError}`);
					return;
				} else if (refreshAccessToken && serverResponse.status && serverResponse.status >= HttpStatus.CLIENT_ERROR_RANGE_START && serverResponse.status <= HttpStatus.CLIENT_ERROR_RANGE_END) {
					this.logger.warning(`executeTokenRequest:validateTokenResponse - AAD is currently available but is unable to refresh the access token.\n${serverError}`);
					return;
				}
				if (isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) throw new InteractionRequiredAuthError(serverResponse.error, serverResponse.error_description, serverResponse.suberror, serverResponse.timestamp || Constants$1.EMPTY_STRING, serverResponse.trace_id || Constants$1.EMPTY_STRING, serverResponse.correlation_id || Constants$1.EMPTY_STRING, serverResponse.claims || Constants$1.EMPTY_STRING, serverErrorNo);
				throw serverError;
			}
		}
		/**
		* Returns a constructed token response based on given string. Also manages the cache updates and cleanups.
		* @param serverTokenResponse
		* @param authority
		*/
		async handleServerTokenResponse(serverTokenResponse, authority, reqTimestamp, request, apiId, authCodePayload, userAssertionHash, handlingRefreshTokenResponse, forceCacheRefreshTokenResponse, serverRequestId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.HandleServerTokenResponse, serverTokenResponse.correlation_id);
			let idTokenClaims;
			if (serverTokenResponse.id_token) {
				idTokenClaims = extractTokenClaims(serverTokenResponse.id_token || Constants$1.EMPTY_STRING, this.cryptoObj.base64Decode);
				if (authCodePayload && authCodePayload.nonce) {
					if (idTokenClaims.nonce !== authCodePayload.nonce) throw createClientAuthError(nonceMismatch);
				}
				if (request.maxAge || request.maxAge === 0) {
					const authTime = idTokenClaims.auth_time;
					if (!authTime) throw createClientAuthError(authTimeNotFound);
					checkMaxAge(authTime, request.maxAge);
				}
			}
			this.homeAccountIdentifier = AccountEntity.generateHomeAccountId(serverTokenResponse.client_info || Constants$1.EMPTY_STRING, authority.authorityType, this.logger, this.cryptoObj, idTokenClaims);
			let requestStateObj;
			if (!!authCodePayload && !!authCodePayload.state) requestStateObj = ProtocolUtils.parseRequestState(this.cryptoObj, authCodePayload.state);
			serverTokenResponse.key_id = serverTokenResponse.key_id || request.sshKid || void 0;
			const cacheRecord = this.generateCacheRecord(serverTokenResponse, authority, reqTimestamp, request, idTokenClaims, userAssertionHash, authCodePayload);
			let cacheContext;
			try {
				if (this.persistencePlugin && this.serializableCache) {
					this.logger.verbose("Persistence enabled, calling beforeCacheAccess");
					cacheContext = new TokenCacheContext(this.serializableCache, true);
					await this.persistencePlugin.beforeCacheAccess(cacheContext);
				}
				if (handlingRefreshTokenResponse && !forceCacheRefreshTokenResponse && cacheRecord.account) {
					if (this.cacheStorage.getAllAccounts({
						homeAccountId: cacheRecord.account.homeAccountId,
						environment: cacheRecord.account.environment
					}, request.correlationId).length < 1) {
						this.logger.warning("Account used to refresh tokens not in persistence, refreshed tokens will not be stored in the cache");
						this.performanceClient?.addFields({ acntLoggedOut: true }, request.correlationId);
						return await ResponseHandler.generateAuthenticationResult(this.cryptoObj, authority, cacheRecord, false, request, idTokenClaims, requestStateObj, void 0, serverRequestId);
					}
				}
				await this.cacheStorage.saveCacheRecord(cacheRecord, request.correlationId, isKmsi(idTokenClaims || {}), apiId, request.storeInCache);
			} finally {
				if (this.persistencePlugin && this.serializableCache && cacheContext) {
					this.logger.verbose("Persistence enabled, calling afterCacheAccess");
					await this.persistencePlugin.afterCacheAccess(cacheContext);
				}
			}
			return ResponseHandler.generateAuthenticationResult(this.cryptoObj, authority, cacheRecord, false, request, idTokenClaims, requestStateObj, serverTokenResponse, serverRequestId);
		}
		/**
		* Generates CacheRecord
		* @param serverTokenResponse
		* @param idTokenObj
		* @param authority
		*/
		generateCacheRecord(serverTokenResponse, authority, reqTimestamp, request, idTokenClaims, userAssertionHash, authCodePayload) {
			const env = authority.getPreferredCache();
			if (!env) throw createClientAuthError(invalidCacheEnvironment);
			const claimsTenantId = getTenantIdFromIdTokenClaims(idTokenClaims);
			let cachedIdToken;
			let cachedAccount;
			if (serverTokenResponse.id_token && !!idTokenClaims) {
				cachedIdToken = createIdTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.id_token, this.clientId, claimsTenantId || "");
				cachedAccount = buildAccountToCache(this.cacheStorage, authority, this.homeAccountIdentifier, this.cryptoObj.base64Decode, request.correlationId, idTokenClaims, serverTokenResponse.client_info, env, claimsTenantId, authCodePayload, void 0, this.logger);
			}
			let cachedAccessToken = null;
			if (serverTokenResponse.access_token) {
				const responseScopes = serverTokenResponse.scope ? ScopeSet.fromString(serverTokenResponse.scope) : new ScopeSet(request.scopes || []);
				const expiresIn = (typeof serverTokenResponse.expires_in === "string" ? parseInt(serverTokenResponse.expires_in, 10) : serverTokenResponse.expires_in) || 0;
				const extExpiresIn = (typeof serverTokenResponse.ext_expires_in === "string" ? parseInt(serverTokenResponse.ext_expires_in, 10) : serverTokenResponse.ext_expires_in) || 0;
				const refreshIn = (typeof serverTokenResponse.refresh_in === "string" ? parseInt(serverTokenResponse.refresh_in, 10) : serverTokenResponse.refresh_in) || void 0;
				const tokenExpirationSeconds = reqTimestamp + expiresIn;
				const extendedTokenExpirationSeconds = tokenExpirationSeconds + extExpiresIn;
				const refreshOnSeconds = refreshIn && refreshIn > 0 ? reqTimestamp + refreshIn : void 0;
				cachedAccessToken = createAccessTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.access_token, this.clientId, claimsTenantId || authority.tenant || "", responseScopes.printScopes(), tokenExpirationSeconds, extendedTokenExpirationSeconds, this.cryptoObj.base64Decode, refreshOnSeconds, serverTokenResponse.token_type, userAssertionHash, serverTokenResponse.key_id, request.claims, request.requestedClaimsHash);
			}
			let cachedRefreshToken = null;
			if (serverTokenResponse.refresh_token) {
				let rtExpiresOn;
				if (serverTokenResponse.refresh_token_expires_in) {
					rtExpiresOn = reqTimestamp + (typeof serverTokenResponse.refresh_token_expires_in === "string" ? parseInt(serverTokenResponse.refresh_token_expires_in, 10) : serverTokenResponse.refresh_token_expires_in);
					this.performanceClient?.addFields({ ntwkRtExpiresOnSeconds: rtExpiresOn }, request.correlationId);
				}
				cachedRefreshToken = createRefreshTokenEntity(this.homeAccountIdentifier, env, serverTokenResponse.refresh_token, this.clientId, serverTokenResponse.foci, userAssertionHash, rtExpiresOn);
			}
			let cachedAppMetadata = null;
			if (serverTokenResponse.foci) cachedAppMetadata = {
				clientId: this.clientId,
				environment: env,
				familyId: serverTokenResponse.foci
			};
			return {
				account: cachedAccount,
				idToken: cachedIdToken,
				accessToken: cachedAccessToken,
				refreshToken: cachedRefreshToken,
				appMetadata: cachedAppMetadata
			};
		}
		/**
		* Creates an @AuthenticationResult from @CacheRecord , @IdToken , and a boolean that states whether or not the result is from cache.
		*
		* Optionally takes a state string that is set as-is in the response.
		*
		* @param cacheRecord
		* @param idTokenObj
		* @param fromTokenCache
		* @param stateString
		*/
		static async generateAuthenticationResult(cryptoObj, authority, cacheRecord, fromTokenCache, request, idTokenClaims, requestState, serverTokenResponse, requestId) {
			let accessToken = Constants$1.EMPTY_STRING;
			let responseScopes = [];
			let expiresOn = null;
			let extExpiresOn;
			let refreshOn;
			let familyId = Constants$1.EMPTY_STRING;
			if (cacheRecord.accessToken) {
				if (cacheRecord.accessToken.tokenType === AuthenticationScheme.POP && !request.popKid) {
					const popTokenGenerator = new PopTokenGenerator(cryptoObj);
					const { secret, keyId } = cacheRecord.accessToken;
					if (!keyId) throw createClientAuthError(keyIdMissing);
					accessToken = await popTokenGenerator.signPopToken(secret, keyId, request);
				} else accessToken = cacheRecord.accessToken.secret;
				responseScopes = ScopeSet.fromString(cacheRecord.accessToken.target).asArray();
				expiresOn = toDateFromSeconds(cacheRecord.accessToken.expiresOn);
				extExpiresOn = toDateFromSeconds(cacheRecord.accessToken.extendedExpiresOn);
				if (cacheRecord.accessToken.refreshOn) refreshOn = toDateFromSeconds(cacheRecord.accessToken.refreshOn);
			}
			if (cacheRecord.appMetadata) familyId = cacheRecord.appMetadata.familyId === THE_FAMILY_ID ? THE_FAMILY_ID : "";
			const uid = idTokenClaims?.oid || idTokenClaims?.sub || "";
			const tid = idTokenClaims?.tid || "";
			if (serverTokenResponse?.spa_accountid && !!cacheRecord.account) cacheRecord.account.nativeAccountId = serverTokenResponse?.spa_accountid;
			const accountInfo = cacheRecord.account ? updateAccountTenantProfileData(AccountEntity.getAccountInfo(cacheRecord.account), void 0, idTokenClaims, cacheRecord.idToken?.secret) : null;
			return {
				authority: authority.canonicalAuthority,
				uniqueId: uid,
				tenantId: tid,
				scopes: responseScopes,
				account: accountInfo,
				idToken: cacheRecord?.idToken?.secret || "",
				idTokenClaims: idTokenClaims || {},
				accessToken,
				fromCache: fromTokenCache,
				expiresOn,
				extExpiresOn,
				refreshOn,
				correlationId: request.correlationId,
				requestId: requestId || Constants$1.EMPTY_STRING,
				familyId,
				tokenType: cacheRecord.accessToken?.tokenType || Constants$1.EMPTY_STRING,
				state: requestState ? requestState.userRequestState : Constants$1.EMPTY_STRING,
				cloudGraphHostName: cacheRecord.account?.cloudGraphHostName || Constants$1.EMPTY_STRING,
				msGraphHost: cacheRecord.account?.msGraphHost || Constants$1.EMPTY_STRING,
				code: serverTokenResponse?.spa_code,
				fromNativeBroker: false
			};
		}
	};
	function buildAccountToCache(cacheStorage, authority, homeAccountId, base64Decode, correlationId, idTokenClaims, clientInfo, environment, claimsTenantId, authCodePayload, nativeAccountId, logger) {
		logger?.verbose("setCachedAccount called");
		const baseAccountKey = cacheStorage.getAccountKeys().find((accountKey) => {
			return accountKey.startsWith(homeAccountId);
		});
		let cachedAccount = null;
		if (baseAccountKey) cachedAccount = cacheStorage.getAccount(baseAccountKey, correlationId);
		const baseAccount = cachedAccount || AccountEntity.createAccount({
			homeAccountId,
			idTokenClaims,
			clientInfo,
			environment,
			cloudGraphHostName: authCodePayload?.cloud_graph_host_name,
			msGraphHost: authCodePayload?.msgraph_host,
			nativeAccountId
		}, authority, base64Decode);
		const tenantProfiles = baseAccount.tenantProfiles || [];
		const tenantId = claimsTenantId || baseAccount.realm;
		if (tenantId && !tenantProfiles.find((tenantProfile) => {
			return tenantProfile.tenantId === tenantId;
		})) {
			const newTenantProfile = buildTenantProfile(homeAccountId, baseAccount.localAccountId, tenantId, idTokenClaims);
			tenantProfiles.push(newTenantProfile);
		}
		baseAccount.tenantProfiles = tenantProfiles;
		return baseAccount;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	async function getClientAssertion(clientAssertion, clientId, tokenEndpoint) {
		if (typeof clientAssertion === "string") return clientAssertion;
		else return clientAssertion({
			clientId,
			tokenEndpoint
		});
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Oauth2.0 Authorization Code client
	* @internal
	*/
	var AuthorizationCodeClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
			this.includeRedirectUri = true;
			this.oidcDefaultScopes = this.config.authOptions.authority.options.OIDCOptions?.defaultScopes;
		}
		/**
		* API to acquire a token in exchange of 'authorization_code` acquired by the user in the first leg of the
		* authorization_code_grant
		* @param request
		* @param apiId - API identifier for telemetry tracking
		*/
		async acquireToken(request, apiId, authCodePayload) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientAcquireToken, request.correlationId);
			if (!request.code) throw createClientAuthError(requestCannotBeMade);
			const reqTimestamp = nowSeconds();
			const response = await invokeAsync(this.executeTokenRequest.bind(this), PerformanceEvents.AuthClientExecuteTokenRequest, this.logger, this.performanceClient, request.correlationId)(this.authority, request);
			const requestId = response.headers?.[HeaderNames.X_MS_REQUEST_ID];
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin, this.performanceClient);
			responseHandler.validateTokenResponse(response.body);
			return invokeAsync(responseHandler.handleServerTokenResponse.bind(responseHandler), PerformanceEvents.HandleServerTokenResponse, this.logger, this.performanceClient, request.correlationId)(response.body, this.authority, reqTimestamp, request, apiId, authCodePayload, void 0, void 0, void 0, requestId);
		}
		/**
		* Used to log out the current user, and redirect the user to the postLogoutRedirectUri.
		* Default behaviour is to redirect the user to `window.location.href`.
		* @param authorityUri
		*/
		getLogoutUri(logoutRequest) {
			if (!logoutRequest) throw createClientConfigurationError(logoutRequestEmpty);
			const queryString = this.createLogoutUrlQueryString(logoutRequest);
			return UrlString.appendQueryString(this.authority.endSessionEndpoint, queryString);
		}
		/**
		* Executes POST request to token endpoint
		* @param authority
		* @param request
		*/
		async executeTokenRequest(authority, request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientExecuteTokenRequest, request.correlationId);
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await invokeAsync(this.createTokenRequestBody.bind(this), PerformanceEvents.AuthClientCreateTokenRequestBody, this.logger, this.performanceClient, request.correlationId)(request);
			let ccsCredential = void 0;
			if (request.clientInfo) try {
				const clientInfo = buildClientInfo(request.clientInfo, this.cryptoUtils.base64Decode);
				ccsCredential = {
					credential: `${clientInfo.uid}${Separators.CLIENT_INFO_SEPARATOR}${clientInfo.utid}`,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				};
			} catch (e) {
				this.logger.verbose("Could not parse client info for CCS Header: " + e);
			}
			const headers = this.createTokenRequestHeaders(ccsCredential || request.ccsCredential);
			const thumbprint = getRequestThumbprint(this.config.authOptions.clientId, request);
			return invokeAsync(this.executePostToTokenEndpoint.bind(this), PerformanceEvents.AuthorizationCodeClientExecutePostToTokenEndpoint, this.logger, this.performanceClient, request.correlationId)(endpoint, requestBody, headers, thumbprint, request.correlationId, PerformanceEvents.AuthorizationCodeClientExecutePostToTokenEndpoint);
		}
		/**
		* Generates a map for all the params to be sent to the service
		* @param request
		*/
		async createTokenRequestBody(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.AuthClientCreateTokenRequestBody, request.correlationId);
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, request.embeddedClientId || request.tokenBodyParameters?.[CLIENT_ID] || this.config.authOptions.clientId);
			if (!this.includeRedirectUri) {
				if (!request.redirectUri) throw createClientConfigurationError(redirectUriEmpty);
			} else addRedirectUri(parameters, request.redirectUri);
			addScopes(parameters, request.scopes, true, this.oidcDefaultScopes);
			addAuthorizationCode(parameters, request.code);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager && !isOidcProtocolMode(this.config)) addServerTelemetry(parameters, this.serverTelemetryManager);
			if (request.codeVerifier) addCodeVerifier(parameters, request.codeVerifier);
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			if (this.config.clientCredentials.clientAssertion) {
				const clientAssertion = this.config.clientCredentials.clientAssertion;
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			addGrantType(parameters, GrantType.AUTHORIZATION_CODE_GRANT);
			addClientInfo(parameters);
			if (request.authenticationScheme === AuthenticationScheme.POP) {
				const popTokenGenerator = new PopTokenGenerator(this.cryptoUtils, this.performanceClient);
				let reqCnfData;
				if (!request.popKid) reqCnfData = (await invokeAsync(popTokenGenerator.generateCnf.bind(popTokenGenerator), PerformanceEvents.PopTokenGenerateCnf, this.logger, this.performanceClient, request.correlationId)(request, this.logger)).reqCnfString;
				else reqCnfData = this.cryptoUtils.encodeKid(request.popKid);
				addPopToken(parameters, reqCnfData);
			} else if (request.authenticationScheme === AuthenticationScheme.SSH) if (request.sshJwk) addSshJwk(parameters, request.sshJwk);
			else throw createClientConfigurationError(missingSshJwk);
			let ccsCred = void 0;
			if (request.clientInfo) try {
				const clientInfo = buildClientInfo(request.clientInfo, this.cryptoUtils.base64Decode);
				ccsCred = {
					credential: `${clientInfo.uid}${Separators.CLIENT_INFO_SEPARATOR}${clientInfo.utid}`,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				};
			} catch (e) {
				this.logger.verbose("Could not parse client info for CCS Header: " + e);
			}
			else ccsCred = request.ccsCredential;
			if (this.config.systemOptions.preventCorsPreflight && ccsCred) switch (ccsCred.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(ccsCred.credential));
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					addCcsUpn(parameters, ccsCred.credential);
					break;
			}
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenBodyParameters) addExtraQueryParameters(parameters, request.tokenBodyParameters);
			if (request.enableSpaAuthorizationCode && (!request.tokenBodyParameters || !request.tokenBodyParameters[RETURN_SPA_CODE])) addExtraQueryParameters(parameters, { [RETURN_SPA_CODE]: "1" });
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : this.config.authOptions.clientCapabilities;
			if (!StringUtils.isEmptyObj(request.claims) || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
			return mapToQueryString(parameters);
		}
		/**
		* This API validates the `EndSessionRequest` and creates a URL
		* @param request
		*/
		createLogoutUrlQueryString(request) {
			const parameters = /* @__PURE__ */ new Map();
			if (request.postLogoutRedirectUri) addPostLogoutRedirectUri(parameters, request.postLogoutRedirectUri);
			if (request.correlationId) addCorrelationId(parameters, request.correlationId);
			if (request.idTokenHint) addIdTokenHint(parameters, request.idTokenHint);
			if (request.state) addState(parameters, request.state);
			if (request.logoutHint) addLogoutHint(parameters, request.logoutHint);
			if (request.extraQueryParameters) addExtraQueryParameters(parameters, request.extraQueryParameters);
			if (this.config.authOptions.instanceAware) addInstanceAware(parameters);
			return mapToQueryString(parameters, this.config.authOptions.encodeExtraQueryParams, request.extraQueryParameters);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const DEFAULT_REFRESH_TOKEN_EXPIRATION_OFFSET_SECONDS = 300;
	/**
	* OAuth2.0 refresh token client
	* @internal
	*/
	var RefreshTokenClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
		}
		async acquireToken(request, apiId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireToken, request.correlationId);
			const reqTimestamp = nowSeconds();
			const response = await invokeAsync(this.executeTokenRequest.bind(this), PerformanceEvents.RefreshTokenClientExecuteTokenRequest, this.logger, this.performanceClient, request.correlationId)(request, this.authority);
			const requestId = response.headers?.[HeaderNames.X_MS_REQUEST_ID];
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(response.body);
			return invokeAsync(responseHandler.handleServerTokenResponse.bind(responseHandler), PerformanceEvents.HandleServerTokenResponse, this.logger, this.performanceClient, request.correlationId)(response.body, this.authority, reqTimestamp, request, apiId, void 0, void 0, true, request.forceCache, requestId);
		}
		/**
		* Gets cached refresh token and attaches to request, then calls acquireToken API
		* @param request
		*/
		async acquireTokenByRefreshToken(request, apiId) {
			if (!request) throw createClientConfigurationError(tokenRequestEmpty);
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireTokenByRefreshToken, request.correlationId);
			if (!request.account) throw createClientAuthError(noAccountInSilentRequest);
			if (this.cacheManager.isAppMetadataFOCI(request.account.environment)) try {
				return await invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, true, apiId);
			} catch (e) {
				const noFamilyRTInCache = e instanceof InteractionRequiredAuthError && e.errorCode === noTokensFound;
				const clientMismatchErrorWithFamilyRT = e instanceof ServerError && e.errorCode === Errors.INVALID_GRANT_ERROR && e.subError === Errors.CLIENT_MISMATCH_ERROR;
				if (noFamilyRTInCache || clientMismatchErrorWithFamilyRT) return invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, false, apiId);
				else throw e;
			}
			return invokeAsync(this.acquireTokenWithCachedRefreshToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, this.logger, this.performanceClient, request.correlationId)(request, false, apiId);
		}
		/**
		* makes a network call to acquire tokens by exchanging RefreshToken available in userCache; throws if refresh token is not cached
		* @param request
		*/
		async acquireTokenWithCachedRefreshToken(request, foci, apiId) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientAcquireTokenWithCachedRefreshToken, request.correlationId);
			const refreshToken = invoke(this.cacheManager.getRefreshToken.bind(this.cacheManager), PerformanceEvents.CacheManagerGetRefreshToken, this.logger, this.performanceClient, request.correlationId)(request.account, foci, request.correlationId, void 0, this.performanceClient);
			if (!refreshToken) throw createInteractionRequiredAuthError(noTokensFound);
			if (refreshToken.expiresOn) {
				const offset = request.refreshTokenExpirationOffsetSeconds || DEFAULT_REFRESH_TOKEN_EXPIRATION_OFFSET_SECONDS;
				this.performanceClient?.addFields({
					cacheRtExpiresOnSeconds: Number(refreshToken.expiresOn),
					rtOffsetSeconds: offset
				}, request.correlationId);
				if (isTokenExpired(refreshToken.expiresOn, offset)) throw createInteractionRequiredAuthError(refreshTokenExpired);
			}
			const refreshTokenRequest = {
				...request,
				refreshToken: refreshToken.secret,
				authenticationScheme: request.authenticationScheme || AuthenticationScheme.BEARER,
				ccsCredential: {
					credential: request.account.homeAccountId,
					type: CcsCredentialType.HOME_ACCOUNT_ID
				}
			};
			try {
				return await invokeAsync(this.acquireToken.bind(this), PerformanceEvents.RefreshTokenClientAcquireToken, this.logger, this.performanceClient, request.correlationId)(refreshTokenRequest, apiId);
			} catch (e) {
				if (e instanceof InteractionRequiredAuthError) {
					if (e.subError === badToken) {
						this.logger.verbose("acquireTokenWithRefreshToken: bad refresh token, removing from cache");
						const badRefreshTokenKey = this.cacheManager.generateCredentialKey(refreshToken);
						this.cacheManager.removeRefreshToken(badRefreshTokenKey, request.correlationId);
					}
				}
				throw e;
			}
		}
		/**
		* Constructs the network message and makes a NW call to the underlying secure token service
		* @param request
		* @param authority
		*/
		async executeTokenRequest(request, authority) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientExecuteTokenRequest, request.correlationId);
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await invokeAsync(this.createTokenRequestBody.bind(this), PerformanceEvents.RefreshTokenClientCreateTokenRequestBody, this.logger, this.performanceClient, request.correlationId)(request);
			const headers = this.createTokenRequestHeaders(request.ccsCredential);
			const thumbprint = getRequestThumbprint(this.config.authOptions.clientId, request);
			return invokeAsync(this.executePostToTokenEndpoint.bind(this), PerformanceEvents.RefreshTokenClientExecutePostToTokenEndpoint, this.logger, this.performanceClient, request.correlationId)(endpoint, requestBody, headers, thumbprint, request.correlationId, PerformanceEvents.RefreshTokenClientExecutePostToTokenEndpoint);
		}
		/**
		* Helper function to create the token request body
		* @param request
		*/
		async createTokenRequestBody(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.RefreshTokenClientCreateTokenRequestBody, request.correlationId);
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, request.embeddedClientId || request.tokenBodyParameters?.[CLIENT_ID] || this.config.authOptions.clientId);
			if (request.redirectUri) addRedirectUri(parameters, request.redirectUri);
			addScopes(parameters, request.scopes, true, this.config.authOptions.authority.options.OIDCOptions?.defaultScopes);
			addGrantType(parameters, GrantType.REFRESH_TOKEN_GRANT);
			addClientInfo(parameters);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager && !isOidcProtocolMode(this.config)) addServerTelemetry(parameters, this.serverTelemetryManager);
			addRefreshToken(parameters, request.refreshToken);
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			if (this.config.clientCredentials.clientAssertion) {
				const clientAssertion = this.config.clientCredentials.clientAssertion;
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			if (request.authenticationScheme === AuthenticationScheme.POP) {
				const popTokenGenerator = new PopTokenGenerator(this.cryptoUtils, this.performanceClient);
				let reqCnfData;
				if (!request.popKid) reqCnfData = (await invokeAsync(popTokenGenerator.generateCnf.bind(popTokenGenerator), PerformanceEvents.PopTokenGenerateCnf, this.logger, this.performanceClient, request.correlationId)(request, this.logger)).reqCnfString;
				else reqCnfData = this.cryptoUtils.encodeKid(request.popKid);
				addPopToken(parameters, reqCnfData);
			} else if (request.authenticationScheme === AuthenticationScheme.SSH) if (request.sshJwk) addSshJwk(parameters, request.sshJwk);
			else throw createClientConfigurationError(missingSshJwk);
			if (this.config.systemOptions.preventCorsPreflight && request.ccsCredential) switch (request.ccsCredential.type) {
				case CcsCredentialType.HOME_ACCOUNT_ID:
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.ccsCredential.credential));
					} catch (e) {
						this.logger.verbose("Could not parse home account ID for CCS Header: " + e);
					}
					break;
				case CcsCredentialType.UPN:
					addCcsUpn(parameters, request.ccsCredential.credential);
					break;
			}
			if (request.embeddedClientId) addBrokerParameters(parameters, this.config.authOptions.clientId, this.config.authOptions.redirectUri);
			if (request.tokenBodyParameters) addExtraQueryParameters(parameters, request.tokenBodyParameters);
			instrumentBrokerParams(parameters, request.correlationId, this.performanceClient);
			const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : this.config.authOptions.clientCapabilities;
			if (!StringUtils.isEmptyObj(request.claims) || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
			return mapToQueryString(parameters);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/** @internal */
	var SilentFlowClient = class extends BaseClient {
		constructor(configuration, performanceClient) {
			super(configuration, performanceClient);
		}
		/**
		* Retrieves token from cache or throws an error if it must be refreshed.
		* @param request
		*/
		async acquireCachedToken(request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.SilentFlowClientAcquireCachedToken, request.correlationId);
			let lastCacheOutcome = CacheOutcome.NOT_APPLICABLE;
			if (request.forceRefresh || !this.config.cacheOptions.claimsBasedCachingEnabled && !StringUtils.isEmptyObj(request.claims)) {
				this.setCacheOutcome(CacheOutcome.FORCE_REFRESH_OR_CLAIMS, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			}
			if (!request.account) throw createClientAuthError(noAccountInSilentRequest);
			const requestTenantId = request.account.tenantId || getTenantFromAuthorityString(request.authority);
			const tokenKeys = this.cacheManager.getTokenKeys();
			const cachedAccessToken = this.cacheManager.getAccessToken(request.account, request, tokenKeys, requestTenantId);
			if (!cachedAccessToken) {
				this.setCacheOutcome(CacheOutcome.NO_CACHED_ACCESS_TOKEN, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			} else if (wasClockTurnedBack(cachedAccessToken.cachedAt) || isTokenExpired(cachedAccessToken.expiresOn, this.config.systemOptions.tokenRenewalOffsetSeconds)) {
				this.setCacheOutcome(CacheOutcome.CACHED_ACCESS_TOKEN_EXPIRED, request.correlationId);
				throw createClientAuthError(tokenRefreshRequired);
			} else if (cachedAccessToken.refreshOn && isTokenExpired(cachedAccessToken.refreshOn, 0)) lastCacheOutcome = CacheOutcome.PROACTIVELY_REFRESHED;
			const environment = request.authority || this.authority.getPreferredCache();
			const cacheRecord = {
				account: this.cacheManager.getAccount(this.cacheManager.generateAccountKey(request.account), request.correlationId),
				accessToken: cachedAccessToken,
				idToken: this.cacheManager.getIdToken(request.account, request.correlationId, tokenKeys, requestTenantId, this.performanceClient),
				refreshToken: null,
				appMetadata: this.cacheManager.readAppMetadataFromCache(environment)
			};
			this.setCacheOutcome(lastCacheOutcome, request.correlationId);
			if (this.config.serverTelemetryManager) this.config.serverTelemetryManager.incrementCacheHits();
			return [await invokeAsync(this.generateResultFromCacheRecord.bind(this), PerformanceEvents.SilentFlowClientGenerateResultFromCacheRecord, this.logger, this.performanceClient, request.correlationId)(cacheRecord, request), lastCacheOutcome];
		}
		setCacheOutcome(cacheOutcome, correlationId) {
			this.serverTelemetryManager?.setCacheOutcome(cacheOutcome);
			this.performanceClient?.addFields({ cacheOutcome }, correlationId);
			if (cacheOutcome !== CacheOutcome.NOT_APPLICABLE) this.logger.info(`Token refresh is required due to cache outcome: ${cacheOutcome}`);
		}
		/**
		* Helper function to build response object from the CacheRecord
		* @param cacheRecord
		*/
		async generateResultFromCacheRecord(cacheRecord, request) {
			this.performanceClient?.addQueueMeasurement(PerformanceEvents.SilentFlowClientGenerateResultFromCacheRecord, request.correlationId);
			let idTokenClaims;
			if (cacheRecord.idToken) idTokenClaims = extractTokenClaims(cacheRecord.idToken.secret, this.config.cryptoInterface.base64Decode);
			if (request.maxAge || request.maxAge === 0) {
				const authTime = idTokenClaims?.auth_time;
				if (!authTime) throw createClientAuthError(authTimeNotFound);
				checkMaxAge(authTime, request.maxAge);
			}
			return ResponseHandler.generateAuthenticationResult(this.cryptoUtils, this.authority, cacheRecord, true, request, idTokenClaims);
		}
	};
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	/**
	* Returns map of parameters that are applicable to all calls to /authorize whether using PKCE or EAR
	* @param config
	* @param request
	* @param logger
	* @param performanceClient
	* @returns
	*/
	function getStandardAuthorizeRequestParameters(authOptions, request, logger, performanceClient) {
		const correlationId = request.correlationId;
		const parameters = /* @__PURE__ */ new Map();
		addClientId(parameters, request.embeddedClientId || request.extraQueryParameters?.[CLIENT_ID] || authOptions.clientId);
		addScopes(parameters, [...request.scopes || [], ...request.extraScopesToConsent || []], true, authOptions.authority.options.OIDCOptions?.defaultScopes);
		addRedirectUri(parameters, request.redirectUri);
		addCorrelationId(parameters, correlationId);
		addResponseMode(parameters, request.responseMode);
		addClientInfo(parameters);
		addCliData(parameters);
		if (request.prompt) addPrompt(parameters, request.prompt);
		if (request.domainHint) addDomainHint(parameters, request.domainHint);
		if (request.prompt !== PromptValue.SELECT_ACCOUNT) {
			if (request.sid && request.prompt === PromptValue.NONE) {
				logger.verbose("createAuthCodeUrlQueryString: Prompt is none, adding sid from request");
				addSid(parameters, request.sid);
			} else if (request.account) {
				const accountSid = extractAccountSid(request.account);
				let accountLoginHintClaim = extractLoginHint(request.account);
				if (accountLoginHintClaim && request.domainHint) {
					logger.warning(`AuthorizationCodeClient.createAuthCodeUrlQueryString: "domainHint" param is set, skipping opaque "login_hint" claim. Please consider not passing domainHint`);
					accountLoginHintClaim = null;
				}
				if (accountLoginHintClaim) {
					logger.verbose("createAuthCodeUrlQueryString: login_hint claim present on account");
					addLoginHint(parameters, accountLoginHintClaim);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				} else if (accountSid && request.prompt === PromptValue.NONE) {
					logger.verbose("createAuthCodeUrlQueryString: Prompt is none, adding sid from account");
					addSid(parameters, accountSid);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				} else if (request.loginHint) {
					logger.verbose("createAuthCodeUrlQueryString: Adding login_hint from request");
					addLoginHint(parameters, request.loginHint);
					addCcsUpn(parameters, request.loginHint);
				} else if (request.account.username) {
					logger.verbose("createAuthCodeUrlQueryString: Adding login_hint from account");
					addLoginHint(parameters, request.account.username);
					try {
						addCcsOid(parameters, buildClientInfoFromHomeAccountId(request.account.homeAccountId));
					} catch (e) {
						logger.verbose("createAuthCodeUrlQueryString: Could not parse home account ID for CCS Header");
					}
				}
			} else if (request.loginHint) {
				logger.verbose("createAuthCodeUrlQueryString: No account, adding login_hint from request");
				addLoginHint(parameters, request.loginHint);
				addCcsUpn(parameters, request.loginHint);
			}
		} else logger.verbose("createAuthCodeUrlQueryString: Prompt is select_account, ignoring account hints");
		if (request.nonce) addNonce(parameters, request.nonce);
		if (request.state) addState(parameters, request.state);
		if (request.embeddedClientId) addBrokerParameters(parameters, authOptions.clientId, authOptions.redirectUri);
		const configClaims = request.skipBrokerClaims && parameters.has(BROKER_CLIENT_ID) ? void 0 : authOptions.clientCapabilities;
		if (request.claims || configClaims && configClaims.length > 0) addClaims(parameters, request.claims, configClaims);
		if (authOptions.instanceAware && (!request.extraQueryParameters || !Object.keys(request.extraQueryParameters).includes(INSTANCE_AWARE))) addInstanceAware(parameters);
		return parameters;
	}
	/**
	* Returns authorize endpoint with given request parameters in the query string
	* @param authority
	* @param requestParameters
	* @returns
	*/
	function getAuthorizeUrl(authority, requestParameters, encodeParams, extraQueryParameters) {
		const queryString = mapToQueryString(requestParameters, encodeParams, extraQueryParameters);
		return UrlString.appendQueryString(authority.authorizationEndpoint, queryString);
	}
	/**
	* Helper to get sid from account. Returns null if idTokenClaims are not present or sid is not present.
	* @param account
	*/
	function extractAccountSid(account) {
		return account.idTokenClaims?.sid || null;
	}
	function extractLoginHint(account) {
		return account.loginHint || account.idTokenClaims?.login_hint || null;
	}
	/*! @azure/msal-common v15.17.0 2026-03-18 */
	const skuGroupSeparator = ",";
	const skuValueSeparator = "|";
	function makeExtraSkuString(params) {
		const { skus, libraryName, libraryVersion, extensionName, extensionVersion } = params;
		const skuMap = new Map([[0, [libraryName, libraryVersion]], [2, [extensionName, extensionVersion]]]);
		let skuArr = [];
		if (skus?.length) {
			skuArr = skus.split(skuGroupSeparator);
			if (skuArr.length < 4) return skus;
		} else skuArr = Array.from({ length: 4 }, () => skuValueSeparator);
		skuMap.forEach((value, key) => {
			if (value.length === 2 && value[0]?.length && value[1]?.length) setSku({
				skuArr,
				index: key,
				skuName: value[0],
				skuVersion: value[1]
			});
		});
		return skuArr.join(skuGroupSeparator);
	}
	function setSku(params) {
		const { skuArr, index, skuName, skuVersion } = params;
		if (index >= skuArr.length) return;
		skuArr[index] = [skuName, skuVersion].join(skuValueSeparator);
	}
	/** @internal */
	var ServerTelemetryManager = class ServerTelemetryManager {
		constructor(telemetryRequest, cacheManager) {
			this.cacheOutcome = CacheOutcome.NOT_APPLICABLE;
			this.cacheManager = cacheManager;
			this.apiId = telemetryRequest.apiId;
			this.correlationId = telemetryRequest.correlationId;
			this.wrapperSKU = telemetryRequest.wrapperSKU || Constants$1.EMPTY_STRING;
			this.wrapperVer = telemetryRequest.wrapperVer || Constants$1.EMPTY_STRING;
			this.telemetryCacheKey = SERVER_TELEM_CONSTANTS.CACHE_KEY + Separators.CACHE_KEY_SEPARATOR + telemetryRequest.clientId;
		}
		/**
		* API to add MSER Telemetry to request
		*/
		generateCurrentRequestHeaderValue() {
			const request = `${this.apiId}${SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR}${this.cacheOutcome}`;
			const platformFieldsArr = [this.wrapperSKU, this.wrapperVer];
			const nativeBrokerErrorCode = this.getNativeBrokerErrorCode();
			if (nativeBrokerErrorCode?.length) platformFieldsArr.push(`broker_error=${nativeBrokerErrorCode}`);
			const platformFields = platformFieldsArr.join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const requestWithRegionDiscoveryFields = [request, this.getRegionDiscoveryFields()].join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			return [
				SERVER_TELEM_CONSTANTS.SCHEMA_VERSION,
				requestWithRegionDiscoveryFields,
				platformFields
			].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
		}
		/**
		* API to add MSER Telemetry for the last failed request
		*/
		generateLastRequestHeaderValue() {
			const lastRequests = this.getLastRequests();
			const maxErrors = ServerTelemetryManager.maxErrorsToSend(lastRequests);
			const failedRequests = lastRequests.failedRequests.slice(0, 2 * maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const errors = lastRequests.errors.slice(0, maxErrors).join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			const errorCount = lastRequests.errors.length;
			const platformFields = [errorCount, maxErrors < errorCount ? SERVER_TELEM_CONSTANTS.OVERFLOW_TRUE : SERVER_TELEM_CONSTANTS.OVERFLOW_FALSE].join(SERVER_TELEM_CONSTANTS.VALUE_SEPARATOR);
			return [
				SERVER_TELEM_CONSTANTS.SCHEMA_VERSION,
				lastRequests.cacheHits,
				failedRequests,
				errors,
				platformFields
			].join(SERVER_TELEM_CONSTANTS.CATEGORY_SEPARATOR);
		}
		/**
		* API to cache token failures for MSER data capture
		* @param error
		*/
		cacheFailedRequest(error) {
			const lastRequests = this.getLastRequests();
			if (lastRequests.errors.length >= SERVER_TELEM_CONSTANTS.MAX_CACHED_ERRORS) {
				lastRequests.failedRequests.shift();
				lastRequests.failedRequests.shift();
				lastRequests.errors.shift();
			}
			lastRequests.failedRequests.push(this.apiId, this.correlationId);
			if (error instanceof Error && !!error && error.toString()) if (error instanceof AuthError) if (error.subError) lastRequests.errors.push(error.subError);
			else if (error.errorCode) lastRequests.errors.push(error.errorCode);
			else lastRequests.errors.push(error.toString());
			else lastRequests.errors.push(error.toString());
			else lastRequests.errors.push(SERVER_TELEM_CONSTANTS.UNKNOWN_ERROR);
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		/**
		* Update server telemetry cache entry by incrementing cache hit counter
		*/
		incrementCacheHits() {
			const lastRequests = this.getLastRequests();
			lastRequests.cacheHits += 1;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
			return lastRequests.cacheHits;
		}
		/**
		* Get the server telemetry entity from cache or initialize a new one
		*/
		getLastRequests() {
			return this.cacheManager.getServerTelemetry(this.telemetryCacheKey) || {
				failedRequests: [],
				errors: [],
				cacheHits: 0
			};
		}
		/**
		* Remove server telemetry cache entry
		*/
		clearTelemetryCache() {
			const lastRequests = this.getLastRequests();
			const numErrorsFlushed = ServerTelemetryManager.maxErrorsToSend(lastRequests);
			if (numErrorsFlushed === lastRequests.errors.length) this.cacheManager.removeItem(this.telemetryCacheKey, this.correlationId);
			else {
				const serverTelemEntity = {
					failedRequests: lastRequests.failedRequests.slice(numErrorsFlushed * 2),
					errors: lastRequests.errors.slice(numErrorsFlushed),
					cacheHits: 0
				};
				this.cacheManager.setServerTelemetry(this.telemetryCacheKey, serverTelemEntity, this.correlationId);
			}
		}
		/**
		* Returns the maximum number of errors that can be flushed to the server in the next network request
		* @param serverTelemetryEntity
		*/
		static maxErrorsToSend(serverTelemetryEntity) {
			let i;
			let maxErrors = 0;
			let dataSize = 0;
			const errorCount = serverTelemetryEntity.errors.length;
			for (i = 0; i < errorCount; i++) {
				const apiId = serverTelemetryEntity.failedRequests[2 * i] || Constants$1.EMPTY_STRING;
				const correlationId = serverTelemetryEntity.failedRequests[2 * i + 1] || Constants$1.EMPTY_STRING;
				const errorCode = serverTelemetryEntity.errors[i] || Constants$1.EMPTY_STRING;
				dataSize += apiId.toString().length + correlationId.toString().length + errorCode.length + 3;
				if (dataSize < SERVER_TELEM_CONSTANTS.MAX_LAST_HEADER_BYTES) maxErrors += 1;
				else break;
			}
			return maxErrors;
		}
		/**
		* Get the region discovery fields
		*
		* @returns string
		*/
		getRegionDiscoveryFields() {
			const regionDiscoveryFields = [];
			regionDiscoveryFields.push(this.regionUsed || Constants$1.EMPTY_STRING);
			regionDiscoveryFields.push(this.regionSource || Constants$1.EMPTY_STRING);
			regionDiscoveryFields.push(this.regionOutcome || Constants$1.EMPTY_STRING);
			return regionDiscoveryFields.join(",");
		}
		/**
		* Update the region discovery metadata
		*
		* @param regionDiscoveryMetadata
		* @returns void
		*/
		updateRegionDiscoveryMetadata(regionDiscoveryMetadata) {
			this.regionUsed = regionDiscoveryMetadata.region_used;
			this.regionSource = regionDiscoveryMetadata.region_source;
			this.regionOutcome = regionDiscoveryMetadata.region_outcome;
		}
		/**
		* Set cache outcome
		*/
		setCacheOutcome(cacheOutcome) {
			this.cacheOutcome = cacheOutcome;
		}
		setNativeBrokerErrorCode(errorCode) {
			const lastRequests = this.getLastRequests();
			lastRequests.nativeBrokerErrorCode = errorCode;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		getNativeBrokerErrorCode() {
			return this.getLastRequests().nativeBrokerErrorCode;
		}
		clearNativeBrokerErrorCode() {
			const lastRequests = this.getLastRequests();
			delete lastRequests.nativeBrokerErrorCode;
			this.cacheManager.setServerTelemetry(this.telemetryCacheKey, lastRequests, this.correlationId);
		}
		static makeExtraSkuString(params) {
			return makeExtraSkuString(params);
		}
	};
	/**
	* This class deserializes cache entities read from the file into in-memory object types defined internally
	* @internal
	*/
	var Deserializer = class {
		/**
		* Parse the JSON blob in memory and deserialize the content
		* @param cachedJson - JSON blob cache
		*/
		static deserializeJSONBlob(jsonFile) {
			return !jsonFile ? {} : JSON.parse(jsonFile);
		}
		/**
		* Deserializes accounts to AccountEntity objects
		* @param accounts - accounts of type SerializedAccountEntity
		*/
		static deserializeAccounts(accounts) {
			const accountObjects = {};
			if (accounts) Object.keys(accounts).map(function(key) {
				const serializedAcc = accounts[key];
				const mappedAcc = {
					homeAccountId: serializedAcc.home_account_id,
					environment: serializedAcc.environment,
					realm: serializedAcc.realm,
					localAccountId: serializedAcc.local_account_id,
					username: serializedAcc.username,
					authorityType: serializedAcc.authority_type,
					name: serializedAcc.name,
					clientInfo: serializedAcc.client_info,
					lastModificationTime: serializedAcc.last_modification_time,
					lastModificationApp: serializedAcc.last_modification_app,
					tenantProfiles: serializedAcc.tenantProfiles?.map((serializedTenantProfile) => {
						return JSON.parse(serializedTenantProfile);
					}),
					lastUpdatedAt: Date.now().toString()
				};
				const account = new AccountEntity();
				CacheManager.toObject(account, mappedAcc);
				accountObjects[key] = account;
			});
			return accountObjects;
		}
		/**
		* Deserializes id tokens to IdTokenEntity objects
		* @param idTokens - credentials of type SerializedIdTokenEntity
		*/
		static deserializeIdTokens(idTokens) {
			const idObjects = {};
			if (idTokens) Object.keys(idTokens).map(function(key) {
				const serializedIdT = idTokens[key];
				idObjects[key] = {
					homeAccountId: serializedIdT.home_account_id,
					environment: serializedIdT.environment,
					credentialType: serializedIdT.credential_type,
					clientId: serializedIdT.client_id,
					secret: serializedIdT.secret,
					realm: serializedIdT.realm,
					lastUpdatedAt: Date.now().toString()
				};
			});
			return idObjects;
		}
		/**
		* Deserializes access tokens to AccessTokenEntity objects
		* @param accessTokens - access tokens of type SerializedAccessTokenEntity
		*/
		static deserializeAccessTokens(accessTokens) {
			const atObjects = {};
			if (accessTokens) Object.keys(accessTokens).map(function(key) {
				const serializedAT = accessTokens[key];
				atObjects[key] = {
					homeAccountId: serializedAT.home_account_id,
					environment: serializedAT.environment,
					credentialType: serializedAT.credential_type,
					clientId: serializedAT.client_id,
					secret: serializedAT.secret,
					realm: serializedAT.realm,
					target: serializedAT.target,
					cachedAt: serializedAT.cached_at,
					expiresOn: serializedAT.expires_on,
					extendedExpiresOn: serializedAT.extended_expires_on,
					refreshOn: serializedAT.refresh_on,
					keyId: serializedAT.key_id,
					tokenType: serializedAT.token_type,
					requestedClaims: serializedAT.requestedClaims,
					requestedClaimsHash: serializedAT.requestedClaimsHash,
					userAssertionHash: serializedAT.userAssertionHash,
					lastUpdatedAt: Date.now().toString()
				};
			});
			return atObjects;
		}
		/**
		* Deserializes refresh tokens to RefreshTokenEntity objects
		* @param refreshTokens - refresh tokens of type SerializedRefreshTokenEntity
		*/
		static deserializeRefreshTokens(refreshTokens) {
			const rtObjects = {};
			if (refreshTokens) Object.keys(refreshTokens).map(function(key) {
				const serializedRT = refreshTokens[key];
				rtObjects[key] = {
					homeAccountId: serializedRT.home_account_id,
					environment: serializedRT.environment,
					credentialType: serializedRT.credential_type,
					clientId: serializedRT.client_id,
					secret: serializedRT.secret,
					familyId: serializedRT.family_id,
					target: serializedRT.target,
					realm: serializedRT.realm,
					lastUpdatedAt: Date.now().toString()
				};
			});
			return rtObjects;
		}
		/**
		* Deserializes appMetadata to AppMetaData objects
		* @param appMetadata - app metadata of type SerializedAppMetadataEntity
		*/
		static deserializeAppMetadata(appMetadata) {
			const appMetadataObjects = {};
			if (appMetadata) Object.keys(appMetadata).map(function(key) {
				const serializedAmdt = appMetadata[key];
				appMetadataObjects[key] = {
					clientId: serializedAmdt.client_id,
					environment: serializedAmdt.environment,
					familyId: serializedAmdt.family_id
				};
			});
			return appMetadataObjects;
		}
		/**
		* Deserialize an inMemory Cache
		* @param jsonCache - JSON blob cache
		*/
		static deserializeAllCache(jsonCache) {
			return {
				accounts: jsonCache.Account ? this.deserializeAccounts(jsonCache.Account) : {},
				idTokens: jsonCache.IdToken ? this.deserializeIdTokens(jsonCache.IdToken) : {},
				accessTokens: jsonCache.AccessToken ? this.deserializeAccessTokens(jsonCache.AccessToken) : {},
				refreshTokens: jsonCache.RefreshToken ? this.deserializeRefreshTokens(jsonCache.RefreshToken) : {},
				appMetadata: jsonCache.AppMetadata ? this.deserializeAppMetadata(jsonCache.AppMetadata) : {}
			};
		}
	};
	/**
	* Warning: This set of exports is purely intended to be used by other MSAL libraries, and should be considered potentially unstable. We strongly discourage using them directly, you do so at your own risk.
	* Breaking changes to these APIs will be shipped under a minor version, instead of a major version.
	*/
	var internals = /* @__PURE__ */ Object.freeze({
		__proto__: null,
		Deserializer,
		Serializer
	});
	const DEFAULT_MANAGED_IDENTITY_ID = "system_assigned_managed_identity";
	const DEFAULT_AUTHORITY_FOR_MANAGED_IDENTITY = `https://login.microsoftonline.com/managed_identity/`;
	/**
	* Managed Identity Headers - used in network requests
	*/
	const ManagedIdentityHeaders = {
		AUTHORIZATION_HEADER_NAME: "Authorization",
		METADATA_HEADER_NAME: "Metadata",
		APP_SERVICE_SECRET_HEADER_NAME: "X-IDENTITY-HEADER",
		ML_AND_SF_SECRET_HEADER_NAME: "secret"
	};
	/**
	* Managed Identity Query Parameters - used in network requests
	*/
	const ManagedIdentityQueryParameters = {
		API_VERSION: "api-version",
		RESOURCE: "resource",
		SHA256_TOKEN_TO_REFRESH: "token_sha256_to_refresh",
		XMS_CC: "xms_cc"
	};
	/**
	* Managed Identity Environment Variable Names
	*/
	const ManagedIdentityEnvironmentVariableNames = {
		AZURE_POD_IDENTITY_AUTHORITY_HOST: "AZURE_POD_IDENTITY_AUTHORITY_HOST",
		DEFAULT_IDENTITY_CLIENT_ID: "DEFAULT_IDENTITY_CLIENT_ID",
		IDENTITY_ENDPOINT: "IDENTITY_ENDPOINT",
		IDENTITY_HEADER: "IDENTITY_HEADER",
		IDENTITY_SERVER_THUMBPRINT: "IDENTITY_SERVER_THUMBPRINT",
		IMDS_ENDPOINT: "IMDS_ENDPOINT",
		MSI_ENDPOINT: "MSI_ENDPOINT",
		MSI_SECRET: "MSI_SECRET"
	};
	/**
	* Managed Identity Source Names
	* @public
	*/
	const ManagedIdentitySourceNames = {
		APP_SERVICE: "AppService",
		AZURE_ARC: "AzureArc",
		CLOUD_SHELL: "CloudShell",
		DEFAULT_TO_IMDS: "DefaultToImds",
		IMDS: "Imds",
		MACHINE_LEARNING: "MachineLearning",
		SERVICE_FABRIC: "ServiceFabric"
	};
	/**
	* Managed Identity Ids
	*/
	const ManagedIdentityIdType = {
		SYSTEM_ASSIGNED: "system-assigned",
		USER_ASSIGNED_CLIENT_ID: "user-assigned-client-id",
		USER_ASSIGNED_RESOURCE_ID: "user-assigned-resource-id",
		USER_ASSIGNED_OBJECT_ID: "user-assigned-object-id"
	};
	/**
	* http methods
	*/
	const HttpMethod = {
		GET: "get",
		POST: "post"
	};
	const ProxyStatus = {
		SUCCESS_RANGE_START: HttpStatus.SUCCESS_RANGE_START,
		SUCCESS_RANGE_END: HttpStatus.SUCCESS_RANGE_END,
		SERVER_ERROR: HttpStatus.SERVER_ERROR
	};
	/**
	* Constants used for region discovery
	*/
	const REGION_ENVIRONMENT_VARIABLE = "REGION_NAME";
	const MSAL_FORCE_REGION = "MSAL_FORCE_REGION";
	/**
	* Constant used for PKCE
	*/
	const RANDOM_OCTET_SIZE = 32;
	/**
	* Constants used in PKCE
	*/
	const Hash = { SHA256: "sha256" };
	/**
	* Constants for encoding schemes
	*/
	const CharSet = { CV_CHARSET: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~" };
	/**
	* Cache Constants
	*/
	const CACHE = { KEY_SEPARATOR: "-" };
	/**
	* Constants
	*/
	const Constants = {
		MSAL_SKU: "msal.js.node",
		JWT_BEARER_ASSERTION_TYPE: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		AUTHORIZATION_PENDING: "authorization_pending",
		HTTP_PROTOCOL: "http://",
		LOCALHOST: "localhost"
	};
	/**
	* API Codes for Telemetry purposes.
	* Before adding a new code you must claim it in the MSAL Telemetry tracker as these number spaces are shared across all MSALs
	* 0-99 Silent Flow
	* 600-699 Device Code Flow
	* 800-899 Auth Code Flow
	*/
	const ApiId = {
		acquireTokenSilent: 62,
		acquireTokenByUsernamePassword: 371,
		acquireTokenByDeviceCode: 671,
		acquireTokenByClientCredential: 771,
		acquireTokenByOBO: 772,
		acquireTokenWithManagedIdentity: 773,
		acquireTokenByCode: 871,
		acquireTokenByRefreshToken: 872
	};
	/**
	* JWT  constants
	*/
	const JwtConstants = {
		RSA_256: "RS256",
		PSS_256: "PS256",
		X5T_256: "x5t#S256",
		X5T: "x5t",
		X5C: "x5c",
		AUDIENCE: "aud",
		EXPIRATION_TIME: "exp",
		ISSUER: "iss",
		SUBJECT: "sub",
		NOT_BEFORE: "nbf",
		JWT_ID: "jti"
	};
	const LOOPBACK_SERVER_CONSTANTS = {
		INTERVAL_MS: 100,
		TIMEOUT_MS: 5e3
	};
	const AZURE_ARC_SECRET_FILE_MAX_SIZE_BYTES = 4096;
	var NetworkUtils = class {
		static getNetworkResponse(headers, body, statusCode) {
			return {
				headers,
				body,
				status: statusCode
			};
		}
		static urlToHttpOptions(url) {
			const options = {
				protocol: url.protocol,
				hostname: url.hostname && url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
				hash: url.hash,
				search: url.search,
				pathname: url.pathname,
				path: `${url.pathname || ""}${url.search || ""}`,
				href: url.href
			};
			if (url.port !== "") options.port = Number(url.port);
			if (url.username || url.password) options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
			return options;
		}
	};
	const name = "@azure/msal-node";
	const version = "3.8.10";
	/**
	* This class implements the API for network requests.
	*/
	var HttpClient = class {
		constructor(proxyUrl, customAgentOptions, loggerOptions) {
			this.networkRequestViaProxy = (httpMethod, destinationUrlString, options, timeout) => {
				const destinationUrl = new URL(destinationUrlString);
				const proxyUrl = new URL(this.proxyUrl);
				const headers = options?.headers || {};
				const tunnelRequestOptions = {
					host: proxyUrl.hostname,
					port: proxyUrl.port,
					method: "CONNECT",
					path: destinationUrl.hostname,
					headers
				};
				if (this.customAgentOptions && Object.keys(this.customAgentOptions).length) tunnelRequestOptions.agent = new http.Agent(this.customAgentOptions);
				let postRequestStringContent = "";
				if (httpMethod === HttpMethod.POST) {
					const body = options?.body || "";
					postRequestStringContent = `Content-Type: application/x-www-form-urlencoded\r
Content-Length: ${body.length}\r\n\r\n${body}`;
				} else if (timeout) tunnelRequestOptions.timeout = timeout;
				const outgoingRequestString = `${httpMethod.toUpperCase()} ${destinationUrl.href} HTTP/1.1\r\nHost: ${destinationUrl.host}\r\nConnection: close\r
` + postRequestStringContent + "\r\n";
				return new Promise((resolve, reject) => {
					const request = http.request(tunnelRequestOptions);
					if (timeout) request.on("timeout", () => {
						this.logUrlWithPiiAwareness(`Request timeout after ${timeout}ms for URL`, destinationUrlString);
						request.destroy();
						reject(/* @__PURE__ */ new Error(`Request time out after ${timeout}ms`));
					});
					request.end();
					request.on("connect", (response, socket) => {
						const proxyStatusCode = response?.statusCode || ProxyStatus.SERVER_ERROR;
						if (proxyStatusCode < ProxyStatus.SUCCESS_RANGE_START || proxyStatusCode > ProxyStatus.SUCCESS_RANGE_END) {
							request.destroy();
							socket.destroy();
							reject(/* @__PURE__ */ new Error(`Error connecting to proxy. Http status code: ${response.statusCode}. Http status message: ${response?.statusMessage || "Unknown"}`));
						}
						socket.write(outgoingRequestString);
						const data = [];
						socket.on("data", (chunk) => {
							data.push(chunk);
						});
						socket.on("end", () => {
							const dataStringArray = Buffer.concat([...data]).toString().split("\r\n");
							const httpStatusCode = parseInt(dataStringArray[0].split(" ")[1]);
							const statusMessage = dataStringArray[0].split(" ").slice(2).join(" ");
							const body = dataStringArray[dataStringArray.length - 1];
							const headersArray = dataStringArray.slice(1, dataStringArray.length - 2);
							const entries = /* @__PURE__ */ new Map();
							headersArray.forEach((header) => {
								/**
								* the header might look like "Content-Length: 1531", but that is just a string
								* it needs to be converted to a key/value pair
								* split the string at the first instance of ":"
								* there may be more than one ":" if the value of the header is supposed to be a JSON object
								*/
								const headerKeyValue = header.split(/* @__PURE__ */ new RegExp(/:\s(.*)/s));
								const headerKey = headerKeyValue[0];
								let headerValue = headerKeyValue[1];
								try {
									const object = JSON.parse(headerValue);
									if (object && typeof object === "object") headerValue = object;
								} catch (e) {}
								entries.set(headerKey, headerValue);
							});
							const parsedHeaders = Object.fromEntries(entries);
							const networkResponse = NetworkUtils.getNetworkResponse(parsedHeaders, this.parseBody(httpStatusCode, statusMessage, parsedHeaders, body), httpStatusCode);
							if (this.shouldDestroyRequest(httpStatusCode, networkResponse)) request.destroy();
							resolve(networkResponse);
						});
						socket.on("error", (chunk) => {
							request.destroy();
							socket.destroy();
							reject(new Error(chunk.toString()));
						});
					});
					request.on("error", (chunk) => {
						this.logger.error(`HttpClient - Proxy request error: ${chunk.toString()}`, "");
						this.logUrlWithPiiAwareness("Destination URL", destinationUrlString);
						this.logUrlWithPiiAwareness("Proxy URL", this.proxyUrl);
						this.logger.error(`HttpClient - Method: ${httpMethod}`, "");
						this.logger.errorPii(`HttpClient - Headers: ${JSON.stringify(headers)}`, "");
						request.destroy();
						reject(new Error(chunk.toString()));
					});
				});
			};
			this.networkRequestViaHttps = (httpMethod, urlString, options, timeout) => {
				const isPostRequest = httpMethod === HttpMethod.POST;
				const body = options?.body || "";
				const url = new URL(urlString);
				const headers = options?.headers || {};
				const customOptions = {
					method: httpMethod,
					headers,
					...NetworkUtils.urlToHttpOptions(url)
				};
				if (this.customAgentOptions && Object.keys(this.customAgentOptions).length) customOptions.agent = new https.Agent(this.customAgentOptions);
				if (isPostRequest) customOptions.headers = {
					...customOptions.headers,
					"Content-Length": body.length
				};
				else if (timeout) customOptions.timeout = timeout;
				return new Promise((resolve, reject) => {
					let request;
					if (customOptions.protocol === "http:") request = http.request(customOptions);
					else request = https.request(customOptions);
					if (isPostRequest) request.write(body);
					if (timeout) request.on("timeout", () => {
						this.logUrlWithPiiAwareness(`HTTPS request timeout after ${timeout}ms for URL`, urlString);
						request.destroy();
						reject(/* @__PURE__ */ new Error(`Request time out after ${timeout}ms`));
					});
					request.end();
					request.on("response", (response) => {
						const headers = response.headers;
						const statusCode = response.statusCode;
						const statusMessage = response.statusMessage;
						const data = [];
						response.on("data", (chunk) => {
							data.push(chunk);
						});
						response.on("end", () => {
							const body = Buffer.concat([...data]).toString();
							const parsedHeaders = headers;
							const networkResponse = NetworkUtils.getNetworkResponse(parsedHeaders, this.parseBody(statusCode, statusMessage, parsedHeaders, body), statusCode);
							if (this.shouldDestroyRequest(statusCode, networkResponse)) request.destroy();
							resolve(networkResponse);
						});
					});
					request.on("error", (chunk) => {
						this.logger.error(`HttpClient - HTTPS request error: ${chunk.toString()}`, "");
						this.logUrlWithPiiAwareness("URL", urlString);
						this.logger.error(`HttpClient - Method: ${httpMethod}`, "");
						this.logger.errorPii(`HttpClient - Headers: ${JSON.stringify(headers)}`, "");
						request.destroy();
						reject(new Error(chunk.toString()));
					});
				});
			};
			/**
			* Check if extra parsing is needed on the repsonse from the server
			* @param statusCode {number} the status code of the response from the server
			* @param statusMessage {string | undefined} the status message of the response from the server
			* @param headers {Record<string, string>} the headers of the response from the server
			* @param body {string} the body from the response of the server
			* @returns {Object} JSON parsed body or error object
			*/
			this.parseBody = (statusCode, statusMessage, headers, body) => {
				let parsedBody;
				try {
					parsedBody = JSON.parse(body);
				} catch (error) {
					let errorType;
					let errorDescriptionHelper;
					if (statusCode >= HttpStatus.CLIENT_ERROR_RANGE_START && statusCode <= HttpStatus.CLIENT_ERROR_RANGE_END) {
						errorType = "client_error";
						errorDescriptionHelper = "A client";
					} else if (statusCode >= HttpStatus.SERVER_ERROR_RANGE_START && statusCode <= HttpStatus.SERVER_ERROR_RANGE_END) {
						errorType = "server_error";
						errorDescriptionHelper = "A server";
					} else {
						errorType = "unknown_error";
						errorDescriptionHelper = "An unknown";
					}
					parsedBody = {
						error: errorType,
						error_description: `${errorDescriptionHelper} error occured.\nHttp status code: ${statusCode}\nHttp status message: ${statusMessage || "Unknown"}\nHeaders: ${JSON.stringify(headers)}`
					};
				}
				return parsedBody;
			};
			/**
			* Helper function to log a formatted message containing URLs, with PII-aware sanitization
			* @param label {string} the label for the log message
			* @param urlString {string} the URL to log
			*/
			this.logUrlWithPiiAwareness = (label, urlString) => {
				if (this.isPiiEnabled) this.logger.errorPii(`HttpClient - ${label}: ${urlString}`, "");
				else {
					let urlHelper;
					try {
						const url = new URL(urlString);
						urlHelper = `${url.protocol}//${url.host}${url.pathname}`;
					} catch {
						urlHelper = urlString.split("?")[0] || "unknown";
					}
					this.logger.error(`HttpClient - ${label}: ${urlHelper} [Enable PII logging to see additional details]`, "");
				}
			};
			/**
			* Helper function to determine if a request should be destroyed based on status code and response body.
			* Checks if the response is an error and not part of the device code flow (authorization_pending).
			* @param statusCode {number} the status code of the response
			* @param networkResponse {NetworkResponse<T>} the network response object
			* @returns {boolean} true if the request should be destroyed, false otherwise
			*/
			this.shouldDestroyRequest = (statusCode, networkResponse) => {
				return (statusCode < HttpStatus.SUCCESS_RANGE_START || statusCode > HttpStatus.SUCCESS_RANGE_END) && !(networkResponse.body && typeof networkResponse.body === "object" && "error" in networkResponse.body && networkResponse.body.error === Constants.AUTHORIZATION_PENDING);
			};
			this.proxyUrl = proxyUrl || "";
			this.customAgentOptions = customAgentOptions || {};
			this.logger = new Logger(loggerOptions || {}, name, version);
			this.isPiiEnabled = this.logger.isPiiLoggingEnabled();
		}
		/**
		* Http Get request
		* @param url
		* @param options
		*/
		async sendGetRequestAsync(url, options, timeout) {
			if (this.proxyUrl) return this.networkRequestViaProxy(HttpMethod.GET, url, options, timeout);
			else return this.networkRequestViaHttps(HttpMethod.GET, url, options, timeout);
		}
		/**
		* Http Post request
		* @param url
		* @param options
		*/
		async sendPostRequestAsync(url, options) {
			if (this.proxyUrl) return this.networkRequestViaProxy(HttpMethod.POST, url, options);
			else return this.networkRequestViaHttps(HttpMethod.POST, url, options);
		}
	};
	const invalidFileExtension = "invalid_file_extension";
	const invalidFilePath = "invalid_file_path";
	const invalidManagedIdentityIdType = "invalid_managed_identity_id_type";
	const invalidSecret = "invalid_secret";
	const missingId = "missing_client_id";
	const networkUnavailable = "network_unavailable";
	const platformNotSupported = "platform_not_supported";
	const unableToCreateAzureArc = "unable_to_create_azure_arc";
	const unableToCreateCloudShell = "unable_to_create_cloud_shell";
	const unableToCreateSource = "unable_to_create_source";
	const unableToReadSecretFile = "unable_to_read_secret_file";
	const userAssignedNotAvailableAtRuntime = "user_assigned_not_available_at_runtime";
	const wwwAuthenticateHeaderMissing = "www_authenticate_header_missing";
	const wwwAuthenticateHeaderUnsupportedFormat = "www_authenticate_header_unsupported_format";
	const MsiEnvironmentVariableUrlMalformedErrorCodes = {
		[ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST]: "azure_pod_identity_authority_host_url_malformed",
		[ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT]: "identity_endpoint_url_malformed",
		[ManagedIdentityEnvironmentVariableNames.IMDS_ENDPOINT]: "imds_endpoint_url_malformed",
		[ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT]: "msi_endpoint_url_malformed"
	};
	/**
	* ManagedIdentityErrorMessage class containing string constants used by error codes and messages.
	*/
	const ManagedIdentityErrorMessages = {
		[invalidFileExtension]: "The file path in the WWW-Authenticate header does not contain a .key file.",
		[invalidFilePath]: "The file path in the WWW-Authenticate header is not in a valid Windows or Linux Format.",
		[invalidManagedIdentityIdType]: "More than one ManagedIdentityIdType was provided.",
		[invalidSecret]: "The secret in the file on the file path in the WWW-Authenticate header is greater than 4096 bytes.",
		[platformNotSupported]: "The platform is not supported by Azure Arc. Azure Arc only supports Windows and Linux.",
		[missingId]: "A ManagedIdentityId id was not provided.",
		[MsiEnvironmentVariableUrlMalformedErrorCodes.AZURE_POD_IDENTITY_AUTHORITY_HOST]: `The Managed Identity's '${ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST}' environment variable is malformed.`,
		[MsiEnvironmentVariableUrlMalformedErrorCodes.IDENTITY_ENDPOINT]: `The Managed Identity's '${ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT}' environment variable is malformed.`,
		[MsiEnvironmentVariableUrlMalformedErrorCodes.IMDS_ENDPOINT]: `The Managed Identity's '${ManagedIdentityEnvironmentVariableNames.IMDS_ENDPOINT}' environment variable is malformed.`,
		[MsiEnvironmentVariableUrlMalformedErrorCodes.MSI_ENDPOINT]: `The Managed Identity's '${ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT}' environment variable is malformed.`,
		[networkUnavailable]: "Authentication unavailable. The request to the managed identity endpoint timed out.",
		[unableToCreateAzureArc]: "Azure Arc Managed Identities can only be system assigned.",
		[unableToCreateCloudShell]: "Cloud Shell Managed Identities can only be system assigned.",
		[unableToCreateSource]: "Unable to create a Managed Identity source based on environment variables.",
		[unableToReadSecretFile]: "Unable to read the secret file.",
		[userAssignedNotAvailableAtRuntime]: "Service Fabric user assigned managed identity ClientId or ResourceId is not configurable at runtime.",
		[wwwAuthenticateHeaderMissing]: "A 401 response was received form the Azure Arc Managed Identity, but the www-authenticate header is missing.",
		[wwwAuthenticateHeaderUnsupportedFormat]: "A 401 response was received form the Azure Arc Managed Identity, but the www-authenticate header is in an unsupported format."
	};
	var ManagedIdentityError = class ManagedIdentityError extends AuthError {
		constructor(errorCode) {
			super(errorCode, ManagedIdentityErrorMessages[errorCode]);
			this.name = "ManagedIdentityError";
			Object.setPrototypeOf(this, ManagedIdentityError.prototype);
		}
	};
	function createManagedIdentityError(errorCode) {
		return new ManagedIdentityError(errorCode);
	}
	var ManagedIdentityId = class {
		get id() {
			return this._id;
		}
		set id(value) {
			this._id = value;
		}
		get idType() {
			return this._idType;
		}
		set idType(value) {
			this._idType = value;
		}
		constructor(managedIdentityIdParams) {
			const userAssignedClientId = managedIdentityIdParams?.userAssignedClientId;
			const userAssignedResourceId = managedIdentityIdParams?.userAssignedResourceId;
			const userAssignedObjectId = managedIdentityIdParams?.userAssignedObjectId;
			if (userAssignedClientId) {
				if (userAssignedResourceId || userAssignedObjectId) throw createManagedIdentityError(invalidManagedIdentityIdType);
				this.id = userAssignedClientId;
				this.idType = ManagedIdentityIdType.USER_ASSIGNED_CLIENT_ID;
			} else if (userAssignedResourceId) {
				if (userAssignedClientId || userAssignedObjectId) throw createManagedIdentityError(invalidManagedIdentityIdType);
				this.id = userAssignedResourceId;
				this.idType = ManagedIdentityIdType.USER_ASSIGNED_RESOURCE_ID;
			} else if (userAssignedObjectId) {
				if (userAssignedClientId || userAssignedResourceId) throw createManagedIdentityError(invalidManagedIdentityIdType);
				this.id = userAssignedObjectId;
				this.idType = ManagedIdentityIdType.USER_ASSIGNED_OBJECT_ID;
			} else {
				this.id = DEFAULT_MANAGED_IDENTITY_ID;
				this.idType = ManagedIdentityIdType.SYSTEM_ASSIGNED;
			}
		}
	};
	/**
	* NodeAuthErrorMessage class containing string constants used by error codes and messages.
	*/
	const NodeAuthErrorMessage = {
		invalidLoopbackAddressType: {
			code: "invalid_loopback_server_address_type",
			desc: "Loopback server address is not type string. This is unexpected."
		},
		unableToLoadRedirectUri: {
			code: "unable_to_load_redirectUrl",
			desc: "Loopback server callback was invoked without a url. This is unexpected."
		},
		noAuthCodeInResponse: {
			code: "no_auth_code_in_response",
			desc: "No auth code found in the server response. Please check your network trace to determine what happened."
		},
		noLoopbackServerExists: {
			code: "no_loopback_server_exists",
			desc: "No loopback server exists yet."
		},
		loopbackServerAlreadyExists: {
			code: "loopback_server_already_exists",
			desc: "Loopback server already exists. Cannot create another."
		},
		loopbackServerTimeout: {
			code: "loopback_server_timeout",
			desc: "Timed out waiting for auth code listener to be registered."
		},
		stateNotFoundError: {
			code: "state_not_found",
			desc: "State not found. Please verify that the request originated from msal."
		},
		thumbprintMissing: {
			code: "thumbprint_missing_from_client_certificate",
			desc: "Client certificate does not contain a SHA-1 or SHA-256 thumbprint."
		},
		redirectUriNotSupported: {
			code: "redirect_uri_not_supported",
			desc: "RedirectUri is not supported in this scenario. Please remove redirectUri from the request."
		}
	};
	var NodeAuthError = class NodeAuthError extends AuthError {
		constructor(errorCode, errorMessage) {
			super(errorCode, errorMessage);
			this.name = "NodeAuthError";
		}
		/**
		* Creates an error thrown if loopback server address is of type string.
		*/
		static createInvalidLoopbackAddressTypeError() {
			return new NodeAuthError(NodeAuthErrorMessage.invalidLoopbackAddressType.code, `${NodeAuthErrorMessage.invalidLoopbackAddressType.desc}`);
		}
		/**
		* Creates an error thrown if the loopback server is unable to get a url.
		*/
		static createUnableToLoadRedirectUrlError() {
			return new NodeAuthError(NodeAuthErrorMessage.unableToLoadRedirectUri.code, `${NodeAuthErrorMessage.unableToLoadRedirectUri.desc}`);
		}
		/**
		* Creates an error thrown if the server response does not contain an auth code.
		*/
		static createNoAuthCodeInResponseError() {
			return new NodeAuthError(NodeAuthErrorMessage.noAuthCodeInResponse.code, `${NodeAuthErrorMessage.noAuthCodeInResponse.desc}`);
		}
		/**
		* Creates an error thrown if the loopback server has not been spun up yet.
		*/
		static createNoLoopbackServerExistsError() {
			return new NodeAuthError(NodeAuthErrorMessage.noLoopbackServerExists.code, `${NodeAuthErrorMessage.noLoopbackServerExists.desc}`);
		}
		/**
		* Creates an error thrown if a loopback server already exists when attempting to create another one.
		*/
		static createLoopbackServerAlreadyExistsError() {
			return new NodeAuthError(NodeAuthErrorMessage.loopbackServerAlreadyExists.code, `${NodeAuthErrorMessage.loopbackServerAlreadyExists.desc}`);
		}
		/**
		* Creates an error thrown if the loopback server times out registering the auth code listener.
		*/
		static createLoopbackServerTimeoutError() {
			return new NodeAuthError(NodeAuthErrorMessage.loopbackServerTimeout.code, `${NodeAuthErrorMessage.loopbackServerTimeout.desc}`);
		}
		/**
		* Creates an error thrown when the state is not present.
		*/
		static createStateNotFoundError() {
			return new NodeAuthError(NodeAuthErrorMessage.stateNotFoundError.code, NodeAuthErrorMessage.stateNotFoundError.desc);
		}
		/**
		* Creates an error thrown when client certificate was provided, but neither the SHA-1 or SHA-256 thumbprints were provided
		*/
		static createThumbprintMissingError() {
			return new NodeAuthError(NodeAuthErrorMessage.thumbprintMissing.code, NodeAuthErrorMessage.thumbprintMissing.desc);
		}
		/**
		* Creates an error thrown when redirectUri is provided in an unsupported scenario
		*/
		static createRedirectUriNotSupportedError() {
			return new NodeAuthError(NodeAuthErrorMessage.redirectUriNotSupported.code, NodeAuthErrorMessage.redirectUriNotSupported.desc);
		}
	};
	const DEFAULT_AUTH_OPTIONS = {
		clientId: Constants$1.EMPTY_STRING,
		authority: Constants$1.DEFAULT_AUTHORITY,
		clientSecret: Constants$1.EMPTY_STRING,
		clientAssertion: Constants$1.EMPTY_STRING,
		clientCertificate: {
			thumbprint: Constants$1.EMPTY_STRING,
			thumbprintSha256: Constants$1.EMPTY_STRING,
			privateKey: Constants$1.EMPTY_STRING,
			x5c: Constants$1.EMPTY_STRING
		},
		knownAuthorities: [],
		cloudDiscoveryMetadata: Constants$1.EMPTY_STRING,
		authorityMetadata: Constants$1.EMPTY_STRING,
		clientCapabilities: [],
		protocolMode: ProtocolMode.AAD,
		azureCloudOptions: {
			azureCloudInstance: AzureCloudInstance.None,
			tenant: Constants$1.EMPTY_STRING
		},
		skipAuthorityMetadataCache: false,
		encodeExtraQueryParams: false
	};
	const DEFAULT_CACHE_OPTIONS = { claimsBasedCachingEnabled: false };
	const DEFAULT_LOGGER_OPTIONS = {
		loggerCallback: () => {},
		piiLoggingEnabled: false,
		logLevel: exports.LogLevel.Info
	};
	const DEFAULT_SYSTEM_OPTIONS = {
		loggerOptions: DEFAULT_LOGGER_OPTIONS,
		networkClient: new HttpClient(),
		proxyUrl: Constants$1.EMPTY_STRING,
		customAgentOptions: {},
		disableInternalRetries: false
	};
	const DEFAULT_TELEMETRY_OPTIONS = { application: {
		appName: Constants$1.EMPTY_STRING,
		appVersion: Constants$1.EMPTY_STRING
	} };
	/**
	* Sets the default options when not explicitly configured from app developer
	*
	* @param auth - Authentication options
	* @param cache - Cache options
	* @param system - System options
	* @param telemetry - Telemetry options
	*
	* @returns Configuration
	* @internal
	*/
	function buildAppConfiguration({ auth, broker, cache, system, telemetry }) {
		const systemOptions = {
			...DEFAULT_SYSTEM_OPTIONS,
			networkClient: new HttpClient(system?.proxyUrl, system?.customAgentOptions),
			loggerOptions: system?.loggerOptions || DEFAULT_LOGGER_OPTIONS,
			disableInternalRetries: system?.disableInternalRetries || false
		};
		if (!!auth.clientCertificate && !!!auth.clientCertificate.thumbprint && !!!auth.clientCertificate.thumbprintSha256) throw NodeAuthError.createStateNotFoundError();
		return {
			auth: {
				...DEFAULT_AUTH_OPTIONS,
				...auth
			},
			broker: { ...broker },
			cache: {
				...DEFAULT_CACHE_OPTIONS,
				...cache
			},
			system: {
				...systemOptions,
				...system
			},
			telemetry: {
				...DEFAULT_TELEMETRY_OPTIONS,
				...telemetry
			}
		};
	}
	function buildManagedIdentityConfiguration({ clientCapabilities, managedIdentityIdParams, system }) {
		const managedIdentityId = new ManagedIdentityId(managedIdentityIdParams);
		const loggerOptions = system?.loggerOptions || DEFAULT_LOGGER_OPTIONS;
		let networkClient;
		if (system?.networkClient) networkClient = system.networkClient;
		else networkClient = new HttpClient(system?.proxyUrl, system?.customAgentOptions);
		return {
			clientCapabilities: clientCapabilities || [],
			managedIdentityId,
			system: {
				loggerOptions,
				networkClient
			},
			disableInternalRetries: system?.disableInternalRetries || false
		};
	}
	var GuidGenerator = class {
		/**
		*
		* RFC4122: The version 4 UUID is meant for generating UUIDs from truly-random or pseudo-random numbers.
		* uuidv4 generates guids from cryprtographically-string random
		*/
		generateGuid() {
			return uuid.v4();
		}
		/**
		* verifies if a string is  GUID
		* @param guid
		*/
		isGuid(guid) {
			return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guid);
		}
	};
	var EncodingUtils = class EncodingUtils {
		/**
		* 'utf8': Multibyte encoded Unicode characters. Many web pages and other document formats use UTF-8.
		* 'base64': Base64 encoding.
		*
		* @param str text
		*/
		static base64Encode(str, encoding) {
			return Buffer.from(str, encoding).toString(EncodingTypes.BASE64);
		}
		/**
		* encode a URL
		* @param str
		*/
		static base64EncodeUrl(str, encoding) {
			return EncodingUtils.base64Encode(str, encoding).replace(/=/g, Constants$1.EMPTY_STRING).replace(/\+/g, "-").replace(/\//g, "_");
		}
		/**
		* 'utf8': Multibyte encoded Unicode characters. Many web pages and other document formats use UTF-8.
		* 'base64': Base64 encoding.
		*
		* @param base64Str Base64 encoded text
		*/
		static base64Decode(base64Str) {
			return Buffer.from(base64Str, EncodingTypes.BASE64).toString("utf8");
		}
		/**
		* @param base64Str Base64 encoded Url
		*/
		static base64DecodeUrl(base64Str) {
			let str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
			while (str.length % 4) str += "=";
			return EncodingUtils.base64Decode(str);
		}
	};
	var HashUtils = class {
		/**
		* generate 'SHA256' hash
		* @param buffer
		*/
		sha256(buffer) {
			return crypto$2.createHash(Hash.SHA256).update(buffer).digest();
		}
	};
	/**
	* https://tools.ietf.org/html/rfc7636#page-8
	*/
	var PkceGenerator = class {
		constructor() {
			this.hashUtils = new HashUtils();
		}
		/**
		* generates the codeVerfier and the challenge from the codeVerfier
		* reference: https://tools.ietf.org/html/rfc7636#section-4.1 and https://tools.ietf.org/html/rfc7636#section-4.2
		*/
		async generatePkceCodes() {
			const verifier = this.generateCodeVerifier();
			return {
				verifier,
				challenge: this.generateCodeChallengeFromVerifier(verifier)
			};
		}
		/**
		* generates the codeVerfier; reference: https://tools.ietf.org/html/rfc7636#section-4.1
		*/
		generateCodeVerifier() {
			const charArr = [];
			const maxNumber = 256 - 256 % CharSet.CV_CHARSET.length;
			while (charArr.length <= RANDOM_OCTET_SIZE) {
				const byte = crypto$2.randomBytes(1)[0];
				if (byte >= maxNumber) continue;
				const index = byte % CharSet.CV_CHARSET.length;
				charArr.push(CharSet.CV_CHARSET[index]);
			}
			const verifier = charArr.join(Constants$1.EMPTY_STRING);
			return EncodingUtils.base64EncodeUrl(verifier);
		}
		/**
		* generate the challenge from the codeVerfier; reference: https://tools.ietf.org/html/rfc7636#section-4.2
		* @param codeVerifier
		*/
		generateCodeChallengeFromVerifier(codeVerifier) {
			return EncodingUtils.base64EncodeUrl(this.hashUtils.sha256(codeVerifier).toString(EncodingTypes.BASE64), EncodingTypes.BASE64);
		}
	};
	/**
	* This class implements MSAL node's crypto interface, which allows it to perform base64 encoding and decoding, generating cryptographically random GUIDs and
	* implementing Proof Key for Code Exchange specs for the OAuth Authorization Code Flow using PKCE (rfc here: https://tools.ietf.org/html/rfc7636).
	* @public
	*/
	var CryptoProvider = class {
		constructor() {
			this.pkceGenerator = new PkceGenerator();
			this.guidGenerator = new GuidGenerator();
			this.hashUtils = new HashUtils();
		}
		/**
		* base64 URL safe encoded string
		*/
		base64UrlEncode() {
			throw new Error("Method not implemented.");
		}
		/**
		* Stringifies and base64Url encodes input public key
		* @param inputKid - public key id
		* @returns Base64Url encoded public key
		*/
		encodeKid() {
			throw new Error("Method not implemented.");
		}
		/**
		* Creates a new random GUID - used to populate state and nonce.
		* @returns string (GUID)
		*/
		createNewGuid() {
			return this.guidGenerator.generateGuid();
		}
		/**
		* Encodes input string to base64.
		* @param input - string to be encoded
		*/
		base64Encode(input) {
			return EncodingUtils.base64Encode(input);
		}
		/**
		* Decodes input string from base64.
		* @param input - string to be decoded
		*/
		base64Decode(input) {
			return EncodingUtils.base64Decode(input);
		}
		/**
		* Generates PKCE codes used in Authorization Code Flow.
		*/
		generatePkceCodes() {
			return this.pkceGenerator.generatePkceCodes();
		}
		/**
		* Generates a keypair, stores it and returns a thumbprint - not yet implemented for node
		*/
		getPublicKeyThumbprint() {
			throw new Error("Method not implemented.");
		}
		/**
		* Removes cryptographic keypair from key store matching the keyId passed in
		* @param kid - public key id
		*/
		removeTokenBindingKey() {
			throw new Error("Method not implemented.");
		}
		/**
		* Removes all cryptographic keys from Keystore
		*/
		clearKeystore() {
			throw new Error("Method not implemented.");
		}
		/**
		* Signs the given object as a jwt payload with private key retrieved by given kid - currently not implemented for node
		*/
		signJwt() {
			throw new Error("Method not implemented.");
		}
		/**
		* Returns the SHA-256 hash of an input string
		*/
		async hashString(plainText) {
			return EncodingUtils.base64EncodeUrl(this.hashUtils.sha256(plainText).toString(EncodingTypes.BASE64), EncodingTypes.BASE64);
		}
	};
	function generateCredentialKey(credential) {
		const familyId = credential.credentialType === CredentialType.REFRESH_TOKEN && credential.familyId || credential.clientId;
		const scheme = credential.tokenType && credential.tokenType.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase() ? credential.tokenType.toLowerCase() : "";
		return [
			credential.homeAccountId,
			credential.environment,
			credential.credentialType,
			familyId,
			credential.realm || "",
			credential.target || "",
			credential.requestedClaimsHash || "",
			scheme
		].join(CACHE.KEY_SEPARATOR).toLowerCase();
	}
	function generateAccountKey(account) {
		const homeTenantId = account.homeAccountId.split(".")[1];
		return [
			account.homeAccountId,
			account.environment,
			homeTenantId || account.tenantId || ""
		].join(CACHE.KEY_SEPARATOR).toLowerCase();
	}
	/**
	* This class implements Storage for node, reading cache from user specified storage location or an  extension library
	* @public
	*/
	var NodeStorage = class extends CacheManager {
		constructor(logger, clientId, cryptoImpl, staticAuthorityOptions) {
			super(clientId, cryptoImpl, logger, new msalCommon.StubPerformanceClient(), staticAuthorityOptions);
			this.cache = {};
			this.changeEmitters = [];
			this.logger = logger;
		}
		/**
		* Queue up callbacks
		* @param func - a callback function for cache change indication
		*/
		registerChangeEmitter(func) {
			this.changeEmitters.push(func);
		}
		/**
		* Invoke the callback when cache changes
		*/
		emitChange() {
			this.changeEmitters.forEach((func) => func.call(null));
		}
		/**
		* Converts cacheKVStore to InMemoryCache
		* @param cache - key value store
		*/
		cacheToInMemoryCache(cache) {
			const inMemoryCache = {
				accounts: {},
				idTokens: {},
				accessTokens: {},
				refreshTokens: {},
				appMetadata: {}
			};
			for (const key in cache) {
				const value = cache[key];
				if (typeof value !== "object") continue;
				if (value instanceof AccountEntity) inMemoryCache.accounts[key] = value;
				else if (isIdTokenEntity(value)) inMemoryCache.idTokens[key] = value;
				else if (isAccessTokenEntity(value)) inMemoryCache.accessTokens[key] = value;
				else if (isRefreshTokenEntity(value)) inMemoryCache.refreshTokens[key] = value;
				else if (isAppMetadataEntity(key, value)) inMemoryCache.appMetadata[key] = value;
				else continue;
			}
			return inMemoryCache;
		}
		/**
		* converts inMemoryCache to CacheKVStore
		* @param inMemoryCache - kvstore map for inmemory
		*/
		inMemoryCacheToCache(inMemoryCache) {
			let cache = this.getCache();
			cache = {
				...cache,
				...inMemoryCache.accounts,
				...inMemoryCache.idTokens,
				...inMemoryCache.accessTokens,
				...inMemoryCache.refreshTokens,
				...inMemoryCache.appMetadata
			};
			return cache;
		}
		/**
		* gets the current in memory cache for the client
		*/
		getInMemoryCache() {
			this.logger.trace("Getting in-memory cache");
			return this.cacheToInMemoryCache(this.getCache());
		}
		/**
		* sets the current in memory cache for the client
		* @param inMemoryCache - key value map in memory
		*/
		setInMemoryCache(inMemoryCache) {
			this.logger.trace("Setting in-memory cache");
			const cache = this.inMemoryCacheToCache(inMemoryCache);
			this.setCache(cache);
			this.emitChange();
		}
		/**
		* get the current cache key-value store
		*/
		getCache() {
			this.logger.trace("Getting cache key-value store");
			return this.cache;
		}
		/**
		* sets the current cache (key value store)
		* @param cacheMap - key value map
		*/
		setCache(cache) {
			this.logger.trace("Setting cache key value store");
			this.cache = cache;
			this.emitChange();
		}
		/**
		* Gets cache item with given key.
		* @param key - lookup key for the cache entry
		*/
		getItem(key) {
			this.logger.tracePii(`Item key: ${key}`);
			return this.getCache()[key];
		}
		/**
		* Gets cache item with given key-value
		* @param key - lookup key for the cache entry
		* @param value - value of the cache entry
		*/
		setItem(key, value) {
			this.logger.tracePii(`Item key: ${key}`);
			const cache = this.getCache();
			cache[key] = value;
			this.setCache(cache);
		}
		generateCredentialKey(credential) {
			return generateCredentialKey(credential);
		}
		generateAccountKey(account) {
			return generateAccountKey(account);
		}
		getAccountKeys() {
			const inMemoryCache = this.getInMemoryCache();
			return Object.keys(inMemoryCache.accounts);
		}
		getTokenKeys() {
			const inMemoryCache = this.getInMemoryCache();
			return {
				idToken: Object.keys(inMemoryCache.idTokens),
				accessToken: Object.keys(inMemoryCache.accessTokens),
				refreshToken: Object.keys(inMemoryCache.refreshTokens)
			};
		}
		/**
		* Reads account from cache, builds it into an account entity and returns it.
		* @param accountKey - lookup key to fetch cache type AccountEntity
		* @returns
		*/
		getAccount(accountKey) {
			return this.getItem(accountKey) ? Object.assign(new AccountEntity(), this.getItem(accountKey)) : null;
		}
		/**
		* set account entity
		* @param account - cache value to be set of type AccountEntity
		*/
		async setAccount(account) {
			const accountKey = this.generateAccountKey(AccountEntity.getAccountInfo(account));
			this.setItem(accountKey, account);
		}
		/**
		* fetch the idToken credential
		* @param idTokenKey - lookup key to fetch cache type IdTokenEntity
		*/
		getIdTokenCredential(idTokenKey) {
			const idToken = this.getItem(idTokenKey);
			if (isIdTokenEntity(idToken)) return idToken;
			return null;
		}
		/**
		* set idToken credential
		* @param idToken - cache value to be set of type IdTokenEntity
		*/
		async setIdTokenCredential(idToken) {
			const idTokenKey = this.generateCredentialKey(idToken);
			this.setItem(idTokenKey, idToken);
		}
		/**
		* fetch the accessToken credential
		* @param accessTokenKey - lookup key to fetch cache type AccessTokenEntity
		*/
		getAccessTokenCredential(accessTokenKey) {
			const accessToken = this.getItem(accessTokenKey);
			if (isAccessTokenEntity(accessToken)) return accessToken;
			return null;
		}
		/**
		* set accessToken credential
		* @param accessToken -  cache value to be set of type AccessTokenEntity
		*/
		async setAccessTokenCredential(accessToken) {
			const accessTokenKey = this.generateCredentialKey(accessToken);
			this.setItem(accessTokenKey, accessToken);
		}
		/**
		* fetch the refreshToken credential
		* @param refreshTokenKey - lookup key to fetch cache type RefreshTokenEntity
		*/
		getRefreshTokenCredential(refreshTokenKey) {
			const refreshToken = this.getItem(refreshTokenKey);
			if (isRefreshTokenEntity(refreshToken)) return refreshToken;
			return null;
		}
		/**
		* set refreshToken credential
		* @param refreshToken - cache value to be set of type RefreshTokenEntity
		*/
		async setRefreshTokenCredential(refreshToken) {
			const refreshTokenKey = this.generateCredentialKey(refreshToken);
			this.setItem(refreshTokenKey, refreshToken);
		}
		/**
		* fetch appMetadata entity from the platform cache
		* @param appMetadataKey - lookup key to fetch cache type AppMetadataEntity
		*/
		getAppMetadata(appMetadataKey) {
			const appMetadata = this.getItem(appMetadataKey);
			if (isAppMetadataEntity(appMetadataKey, appMetadata)) return appMetadata;
			return null;
		}
		/**
		* set appMetadata entity to the platform cache
		* @param appMetadata - cache value to be set of type AppMetadataEntity
		*/
		setAppMetadata(appMetadata) {
			const appMetadataKey = generateAppMetadataKey(appMetadata);
			this.setItem(appMetadataKey, appMetadata);
		}
		/**
		* fetch server telemetry entity from the platform cache
		* @param serverTelemetrykey - lookup key to fetch cache type ServerTelemetryEntity
		*/
		getServerTelemetry(serverTelemetrykey) {
			const serverTelemetryEntity = this.getItem(serverTelemetrykey);
			if (serverTelemetryEntity && isServerTelemetryEntity(serverTelemetrykey, serverTelemetryEntity)) return serverTelemetryEntity;
			return null;
		}
		/**
		* set server telemetry entity to the platform cache
		* @param serverTelemetryKey - lookup key to fetch cache type ServerTelemetryEntity
		* @param serverTelemetry - cache value to be set of type ServerTelemetryEntity
		*/
		setServerTelemetry(serverTelemetryKey, serverTelemetry) {
			this.setItem(serverTelemetryKey, serverTelemetry);
		}
		/**
		* fetch authority metadata entity from the platform cache
		* @param key - lookup key to fetch cache type AuthorityMetadataEntity
		*/
		getAuthorityMetadata(key) {
			const authorityMetadataEntity = this.getItem(key);
			if (authorityMetadataEntity && isAuthorityMetadataEntity(key, authorityMetadataEntity)) return authorityMetadataEntity;
			return null;
		}
		/**
		* Get all authority metadata keys
		*/
		getAuthorityMetadataKeys() {
			return this.getKeys().filter((key) => {
				return this.isAuthorityMetadata(key);
			});
		}
		/**
		* set authority metadata entity to the platform cache
		* @param key - lookup key to fetch cache type AuthorityMetadataEntity
		* @param metadata - cache value to be set of type AuthorityMetadataEntity
		*/
		setAuthorityMetadata(key, metadata) {
			this.setItem(key, metadata);
		}
		/**
		* fetch throttling entity from the platform cache
		* @param throttlingCacheKey - lookup key to fetch cache type ThrottlingEntity
		*/
		getThrottlingCache(throttlingCacheKey) {
			const throttlingCache = this.getItem(throttlingCacheKey);
			if (throttlingCache && isThrottlingEntity(throttlingCacheKey, throttlingCache)) return throttlingCache;
			return null;
		}
		/**
		* set throttling entity to the platform cache
		* @param throttlingCacheKey - lookup key to fetch cache type ThrottlingEntity
		* @param throttlingCache - cache value to be set of type ThrottlingEntity
		*/
		setThrottlingCache(throttlingCacheKey, throttlingCache) {
			this.setItem(throttlingCacheKey, throttlingCache);
		}
		/**
		* Removes the cache item from memory with the given key.
		* @param key - lookup key to remove a cache entity
		* @param inMemory - key value map of the cache
		*/
		removeItem(key) {
			this.logger.tracePii(`Item key: ${key}`);
			let result = false;
			const cache = this.getCache();
			if (!!cache[key]) {
				delete cache[key];
				result = true;
			}
			if (result) {
				this.setCache(cache);
				this.emitChange();
			}
			return result;
		}
		/**
		* Remove account entity from the platform cache if it's outdated
		* @param accountKey - lookup key to fetch cache type AccountEntity
		*/
		removeOutdatedAccount(accountKey) {
			this.removeItem(accountKey);
		}
		/**
		* Checks whether key is in cache.
		* @param key - look up key for a cache entity
		*/
		containsKey(key) {
			return this.getKeys().includes(key);
		}
		/**
		* Gets all keys in window.
		*/
		getKeys() {
			this.logger.trace("Retrieving all cache keys");
			const cache = this.getCache();
			return [...Object.keys(cache)];
		}
		/**
		* Clears all cache entries created by MSAL (except tokens).
		*/
		clear() {
			this.logger.trace("Clearing cache entries created by MSAL");
			this.getKeys().forEach((key) => {
				this.removeItem(key);
			});
			this.emitChange();
		}
		/**
		* Initialize in memory cache from an exisiting cache vault
		* @param cache - blob formatted cache (JSON)
		*/
		static generateInMemoryCache(cache) {
			return Deserializer.deserializeAllCache(Deserializer.deserializeJSONBlob(cache));
		}
		/**
		* retrieves the final JSON
		* @param inMemoryCache - itemised cache read from the JSON
		*/
		static generateJsonCache(inMemoryCache) {
			return Serializer.serializeAllCache(inMemoryCache);
		}
		/**
		* Updates a credential's cache key if the current cache key is outdated
		*/
		updateCredentialCacheKey(currentCacheKey, credential) {
			const updatedCacheKey = this.generateCredentialKey(credential);
			if (currentCacheKey !== updatedCacheKey) {
				const cacheItem = this.getItem(currentCacheKey);
				if (cacheItem) {
					this.removeItem(currentCacheKey);
					this.setItem(updatedCacheKey, cacheItem);
					this.logger.verbose(`Updated an outdated ${credential.credentialType} cache key`);
					return updatedCacheKey;
				} else this.logger.error(`Attempted to update an outdated ${credential.credentialType} cache key but no item matching the outdated key was found in storage`);
			}
			return currentCacheKey;
		}
	};
	const defaultSerializedCache = {
		Account: {},
		IdToken: {},
		AccessToken: {},
		RefreshToken: {},
		AppMetadata: {}
	};
	/**
	* In-memory token cache manager
	* @public
	*/
	var TokenCache = class {
		constructor(storage, logger, cachePlugin) {
			this.cacheHasChanged = false;
			this.storage = storage;
			this.storage.registerChangeEmitter(this.handleChangeEvent.bind(this));
			if (cachePlugin) this.persistence = cachePlugin;
			this.logger = logger;
		}
		/**
		* Set to true if cache state has changed since last time serialize or writeToPersistence was called
		*/
		hasChanged() {
			return this.cacheHasChanged;
		}
		/**
		* Serializes in memory cache to JSON
		*/
		serialize() {
			this.logger.trace("Serializing in-memory cache");
			let finalState = Serializer.serializeAllCache(this.storage.getInMemoryCache());
			if (this.cacheSnapshot) {
				this.logger.trace("Reading cache snapshot from disk");
				finalState = this.mergeState(JSON.parse(this.cacheSnapshot), finalState);
			} else this.logger.trace("No cache snapshot to merge");
			this.cacheHasChanged = false;
			return JSON.stringify(finalState);
		}
		/**
		* Deserializes JSON to in-memory cache. JSON should be in MSAL cache schema format
		* @param cache - blob formatted cache
		*/
		deserialize(cache) {
			this.logger.trace("Deserializing JSON to in-memory cache");
			this.cacheSnapshot = cache;
			if (this.cacheSnapshot) {
				this.logger.trace("Reading cache snapshot from disk");
				const deserializedCache = Deserializer.deserializeAllCache(this.overlayDefaults(JSON.parse(this.cacheSnapshot)));
				this.storage.setInMemoryCache(deserializedCache);
			} else this.logger.trace("No cache snapshot to deserialize");
		}
		/**
		* Fetches the cache key-value map
		*/
		getKVStore() {
			return this.storage.getCache();
		}
		/**
		* Gets cache snapshot in CacheKVStore format
		*/
		getCacheSnapshot() {
			const deserializedPersistentStorage = NodeStorage.generateInMemoryCache(this.cacheSnapshot);
			return this.storage.inMemoryCacheToCache(deserializedPersistentStorage);
		}
		/**
		* API that retrieves all accounts currently in cache to the user
		*/
		async getAllAccounts(correlationId = new CryptoProvider().createNewGuid()) {
			this.logger.trace("getAllAccounts called");
			let cacheContext;
			try {
				if (this.persistence) {
					cacheContext = new TokenCacheContext(this, false);
					await this.persistence.beforeCacheAccess(cacheContext);
				}
				return this.storage.getAllAccounts({}, correlationId);
			} finally {
				if (this.persistence && cacheContext) await this.persistence.afterCacheAccess(cacheContext);
			}
		}
		/**
		* Returns the signed in account matching homeAccountId.
		* (the account object is created at the time of successful login)
		* or null when no matching account is found
		* @param homeAccountId - unique identifier for an account (uid.utid)
		*/
		async getAccountByHomeId(homeAccountId) {
			const allAccounts = await this.getAllAccounts();
			if (homeAccountId && allAccounts && allAccounts.length) return allAccounts.filter((accountObj) => accountObj.homeAccountId === homeAccountId)[0] || null;
			else return null;
		}
		/**
		* Returns the signed in account matching localAccountId.
		* (the account object is created at the time of successful login)
		* or null when no matching account is found
		* @param localAccountId - unique identifier of an account (sub/obj when homeAccountId cannot be populated)
		*/
		async getAccountByLocalId(localAccountId) {
			const allAccounts = await this.getAllAccounts();
			if (localAccountId && allAccounts && allAccounts.length) return allAccounts.filter((accountObj) => accountObj.localAccountId === localAccountId)[0] || null;
			else return null;
		}
		/**
		* API to remove a specific account and the relevant data from cache
		* @param account - AccountInfo passed by the user
		*/
		async removeAccount(account, correlationId) {
			this.logger.trace("removeAccount called");
			let cacheContext;
			try {
				if (this.persistence) {
					cacheContext = new TokenCacheContext(this, true);
					await this.persistence.beforeCacheAccess(cacheContext);
				}
				this.storage.removeAccount(account, correlationId || new GuidGenerator().generateGuid());
			} finally {
				if (this.persistence && cacheContext) await this.persistence.afterCacheAccess(cacheContext);
			}
		}
		/**
		* Overwrites in-memory cache with persistent cache
		*/
		async overwriteCache() {
			if (!this.persistence) {
				this.logger.info("No persistence layer specified, cache cannot be overwritten");
				return;
			}
			this.logger.info("Overwriting in-memory cache with persistent cache");
			this.storage.clear();
			const cacheContext = new TokenCacheContext(this, false);
			await this.persistence.beforeCacheAccess(cacheContext);
			const cacheSnapshot = this.getCacheSnapshot();
			this.storage.setCache(cacheSnapshot);
			await this.persistence.afterCacheAccess(cacheContext);
		}
		/**
		* Called when the cache has changed state.
		*/
		handleChangeEvent() {
			this.cacheHasChanged = true;
		}
		/**
		* Merge in memory cache with the cache snapshot.
		* @param oldState - cache before changes
		* @param currentState - current cache state in the library
		*/
		mergeState(oldState, currentState) {
			this.logger.trace("Merging in-memory cache with cache snapshot");
			const stateAfterRemoval = this.mergeRemovals(oldState, currentState);
			return this.mergeUpdates(stateAfterRemoval, currentState);
		}
		/**
		* Deep update of oldState based on newState values
		* @param oldState - cache before changes
		* @param newState - updated cache
		*/
		mergeUpdates(oldState, newState) {
			Object.keys(newState).forEach((newKey) => {
				const newValue = newState[newKey];
				if (!oldState.hasOwnProperty(newKey)) {
					if (newValue !== null) oldState[newKey] = newValue;
				} else {
					const newValueNotNull = newValue !== null;
					const newValueIsObject = typeof newValue === "object";
					const newValueIsNotArray = !Array.isArray(newValue);
					const oldStateNotUndefinedOrNull = typeof oldState[newKey] !== "undefined" && oldState[newKey] !== null;
					if (newValueNotNull && newValueIsObject && newValueIsNotArray && oldStateNotUndefinedOrNull) this.mergeUpdates(oldState[newKey], newValue);
					else oldState[newKey] = newValue;
				}
			});
			return oldState;
		}
		/**
		* Removes entities in oldState that the were removed from newState. If there are any unknown values in root of
		* oldState that are not recognized, they are left untouched.
		* @param oldState - cache before changes
		* @param newState - updated cache
		*/
		mergeRemovals(oldState, newState) {
			this.logger.trace("Remove updated entries in cache");
			const accounts = oldState.Account ? this.mergeRemovalsDict(oldState.Account, newState.Account) : oldState.Account;
			const accessTokens = oldState.AccessToken ? this.mergeRemovalsDict(oldState.AccessToken, newState.AccessToken) : oldState.AccessToken;
			const refreshTokens = oldState.RefreshToken ? this.mergeRemovalsDict(oldState.RefreshToken, newState.RefreshToken) : oldState.RefreshToken;
			const idTokens = oldState.IdToken ? this.mergeRemovalsDict(oldState.IdToken, newState.IdToken) : oldState.IdToken;
			const appMetadata = oldState.AppMetadata ? this.mergeRemovalsDict(oldState.AppMetadata, newState.AppMetadata) : oldState.AppMetadata;
			return {
				...oldState,
				Account: accounts,
				AccessToken: accessTokens,
				RefreshToken: refreshTokens,
				IdToken: idTokens,
				AppMetadata: appMetadata
			};
		}
		/**
		* Helper to merge new cache with the old one
		* @param oldState - cache before changes
		* @param newState - updated cache
		*/
		mergeRemovalsDict(oldState, newState) {
			const finalState = { ...oldState };
			Object.keys(oldState).forEach((oldKey) => {
				if (!newState || !newState.hasOwnProperty(oldKey)) delete finalState[oldKey];
			});
			return finalState;
		}
		/**
		* Helper to overlay as a part of cache merge
		* @param passedInCache - cache read from the blob
		*/
		overlayDefaults(passedInCache) {
			this.logger.trace("Overlaying input cache with the default cache");
			return {
				Account: {
					...defaultSerializedCache.Account,
					...passedInCache.Account
				},
				IdToken: {
					...defaultSerializedCache.IdToken,
					...passedInCache.IdToken
				},
				AccessToken: {
					...defaultSerializedCache.AccessToken,
					...passedInCache.AccessToken
				},
				RefreshToken: {
					...defaultSerializedCache.RefreshToken,
					...passedInCache.RefreshToken
				},
				AppMetadata: {
					...defaultSerializedCache.AppMetadata,
					...passedInCache.AppMetadata
				}
			};
		}
	};
	/**
	* Client assertion of type jwt-bearer used in confidential client flows
	* @public
	*/
	var ClientAssertion = class ClientAssertion {
		/**
		* Initialize the ClientAssertion class from the clientAssertion passed by the user
		* @param assertion - refer https://tools.ietf.org/html/rfc7521
		*/
		static fromAssertion(assertion) {
			const clientAssertion = new ClientAssertion();
			clientAssertion.jwt = assertion;
			return clientAssertion;
		}
		/**
		* @deprecated Use fromCertificateWithSha256Thumbprint instead, with a SHA-256 thumprint
		* Initialize the ClientAssertion class from the certificate passed by the user
		* @param thumbprint - identifier of a certificate
		* @param privateKey - secret key
		* @param publicCertificate - electronic document provided to prove the ownership of the public key
		*/
		static fromCertificate(thumbprint, privateKey, publicCertificate) {
			const clientAssertion = new ClientAssertion();
			clientAssertion.privateKey = privateKey;
			clientAssertion.thumbprint = thumbprint;
			clientAssertion.useSha256 = false;
			if (publicCertificate) clientAssertion.publicCertificate = this.parseCertificate(publicCertificate);
			return clientAssertion;
		}
		/**
		* Initialize the ClientAssertion class from the certificate passed by the user
		* @param thumbprint - identifier of a certificate
		* @param privateKey - secret key
		* @param publicCertificate - electronic document provided to prove the ownership of the public key
		*/
		static fromCertificateWithSha256Thumbprint(thumbprint, privateKey, publicCertificate) {
			const clientAssertion = new ClientAssertion();
			clientAssertion.privateKey = privateKey;
			clientAssertion.thumbprint = thumbprint;
			clientAssertion.useSha256 = true;
			if (publicCertificate) clientAssertion.publicCertificate = this.parseCertificate(publicCertificate);
			return clientAssertion;
		}
		/**
		* Update JWT for certificate based clientAssertion, if passed by the user, uses it as is
		* @param cryptoProvider - library's crypto helper
		* @param issuer - iss claim
		* @param jwtAudience - aud claim
		*/
		getJwt(cryptoProvider, issuer, jwtAudience) {
			if (this.privateKey && this.thumbprint) {
				if (this.jwt && !this.isExpired() && issuer === this.issuer && jwtAudience === this.jwtAudience) return this.jwt;
				return this.createJwt(cryptoProvider, issuer, jwtAudience);
			}
			if (this.jwt) return this.jwt;
			throw createClientAuthError(invalidAssertion);
		}
		/**
		* JWT format and required claims specified: https://tools.ietf.org/html/rfc7523#section-3
		*/
		createJwt(cryptoProvider, issuer, jwtAudience) {
			this.issuer = issuer;
			this.jwtAudience = jwtAudience;
			const issuedAt = nowSeconds();
			this.expirationTime = issuedAt + 600;
			const header = { alg: this.useSha256 ? JwtConstants.PSS_256 : JwtConstants.RSA_256 };
			const thumbprintHeader = this.useSha256 ? JwtConstants.X5T_256 : JwtConstants.X5T;
			Object.assign(header, { [thumbprintHeader]: EncodingUtils.base64EncodeUrl(this.thumbprint, EncodingTypes.HEX) });
			if (this.publicCertificate) Object.assign(header, { [JwtConstants.X5C]: this.publicCertificate });
			const payload = {
				[JwtConstants.AUDIENCE]: this.jwtAudience,
				[JwtConstants.EXPIRATION_TIME]: this.expirationTime,
				[JwtConstants.ISSUER]: this.issuer,
				[JwtConstants.SUBJECT]: this.issuer,
				[JwtConstants.NOT_BEFORE]: issuedAt,
				[JwtConstants.JWT_ID]: cryptoProvider.createNewGuid()
			};
			this.jwt = jwt.sign(payload, this.privateKey, { header });
			return this.jwt;
		}
		/**
		* Utility API to check expiration
		*/
		isExpired() {
			return this.expirationTime < nowSeconds();
		}
		/**
		* Extracts the raw certs from a given certificate string and returns them in an array.
		* @param publicCertificate - electronic document provided to prove the ownership of the public key
		*/
		static parseCertificate(publicCertificate) {
			/**
			* This is regex to identify the certs in a given certificate string.
			* We want to look for the contents between the BEGIN and END certificate strings, without the associated newlines.
			* The information in parens "(.+?)" is the capture group to represent the cert we want isolated.
			* "." means any string character, "+" means match 1 or more times, and "?" means the shortest match.
			* The "g" at the end of the regex means search the string globally, and the "s" enables the "." to match newlines.
			*/
			const regexToFindCerts = /-----BEGIN CERTIFICATE-----\r*\n(.+?)\r*\n-----END CERTIFICATE-----/gs;
			const certs = [];
			let matches;
			while ((matches = regexToFindCerts.exec(publicCertificate)) !== null) certs.push(matches[1].replace(/\r*\n/g, Constants$1.EMPTY_STRING));
			return certs;
		}
	};
	/**
	* Oauth2.0 Password grant client
	* Note: We are only supporting public clients for password grant and for purely testing purposes
	* @public
	* @deprecated - Use a more secure flow instead
	*/
	var UsernamePasswordClient = class extends BaseClient {
		constructor(configuration) {
			super(configuration);
		}
		/**
		* API to acquire a token by passing the username and password to the service in exchage of credentials
		* password_grant
		* @param request - CommonUsernamePasswordRequest
		*/
		async acquireToken(request) {
			this.logger.info("in acquireToken call in username-password client");
			const reqTimestamp = nowSeconds();
			const response = await this.executeTokenRequest(this.authority, request);
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(response.body);
			return responseHandler.handleServerTokenResponse(response.body, this.authority, reqTimestamp, request, ApiId.acquireTokenByUsernamePassword);
		}
		/**
		* Executes POST request to token endpoint
		* @param authority - authority object
		* @param request - CommonUsernamePasswordRequest provided by the developer
		*/
		async executeTokenRequest(authority, request) {
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await this.createTokenRequestBody(request);
			const headers = this.createTokenRequestHeaders({
				credential: request.username,
				type: CcsCredentialType.UPN
			});
			const thumbprint = {
				clientId: this.config.authOptions.clientId,
				authority: authority.canonicalAuthority,
				scopes: request.scopes,
				claims: request.claims,
				authenticationScheme: request.authenticationScheme,
				resourceRequestMethod: request.resourceRequestMethod,
				resourceRequestUri: request.resourceRequestUri,
				shrClaims: request.shrClaims,
				sshKid: request.sshKid
			};
			return this.executePostToTokenEndpoint(endpoint, requestBody, headers, thumbprint, request.correlationId);
		}
		/**
		* Generates a map for all the params to be sent to the service
		* @param request - CommonUsernamePasswordRequest provided by the developer
		*/
		async createTokenRequestBody(request) {
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, this.config.authOptions.clientId);
			addUsername(parameters, request.username);
			addPassword(parameters, request.password);
			addScopes(parameters, request.scopes);
			addResponseType(parameters, OAuthResponseType.IDTOKEN_TOKEN);
			addGrantType(parameters, GrantType.RESOURCE_OWNER_PASSWORD_GRANT);
			addClientInfo(parameters);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager) addServerTelemetry(parameters, this.serverTelemetryManager);
			addCorrelationId(parameters, request.correlationId || this.config.cryptoInterface.createNewGuid());
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			const clientAssertion = this.config.clientCredentials.clientAssertion;
			if (clientAssertion) {
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			if (!StringUtils.isEmptyObj(request.claims) || this.config.authOptions.clientCapabilities && this.config.authOptions.clientCapabilities.length > 0) addClaims(parameters, request.claims, this.config.authOptions.clientCapabilities);
			if (this.config.systemOptions.preventCorsPreflight && request.username) addCcsUpn(parameters, request.username);
			return mapToQueryString(parameters);
		}
	};
	/**
	* Constructs the full /authorize URL with request parameters
	* @param config
	* @param authority
	* @param request
	* @param logger
	* @returns
	*/
	function getAuthCodeRequestUrl(config, authority, request, logger) {
		const parameters = getStandardAuthorizeRequestParameters({
			...config.auth,
			authority,
			redirectUri: request.redirectUri || ""
		}, request, logger);
		addLibraryInfo(parameters, {
			sku: Constants.MSAL_SKU,
			version,
			cpu: process.arch || "",
			os: process.platform || ""
		});
		if (config.auth.protocolMode !== ProtocolMode.OIDC) addApplicationTelemetry(parameters, config.telemetry.application);
		addResponseType(parameters, OAuthResponseType.CODE);
		if (request.codeChallenge && request.codeChallengeMethod) addCodeChallengeParams(parameters, request.codeChallenge, request.codeChallengeMethod);
		addExtraQueryParameters(parameters, request.extraQueryParameters || {});
		return getAuthorizeUrl(authority, parameters, config.auth.encodeExtraQueryParams, request.extraQueryParameters);
	}
	/**
	* Base abstract class for all ClientApplications - public and confidential
	* @public
	*/
	var ClientApplication = class {
		/**
		* Constructor for the ClientApplication
		*/
		constructor(configuration) {
			this.config = buildAppConfiguration(configuration);
			this.cryptoProvider = new CryptoProvider();
			this.logger = new Logger(this.config.system.loggerOptions, name, version);
			this.storage = new NodeStorage(this.logger, this.config.auth.clientId, this.cryptoProvider, buildStaticAuthorityOptions(this.config.auth));
			this.tokenCache = new TokenCache(this.storage, this.logger, this.config.cache.cachePlugin);
		}
		/**
		* Creates the URL of the authorization request, letting the user input credentials and consent to the
		* application. The URL targets the /authorize endpoint of the authority configured in the
		* application object.
		*
		* Once the user inputs their credentials and consents, the authority will send a response to the redirect URI
		* sent in the request and should contain an authorization code, which can then be used to acquire tokens via
		* `acquireTokenByCode(AuthorizationCodeRequest)`.
		*/
		async getAuthCodeUrl(request) {
			this.logger.info("getAuthCodeUrl called", request.correlationId);
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request),
				responseMode: request.responseMode || ResponseMode.QUERY,
				authenticationScheme: AuthenticationScheme.BEARER,
				state: request.state || "",
				nonce: request.nonce || ""
			};
			const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
			return getAuthCodeRequestUrl(this.config, discoveredAuthority, validRequest, this.logger);
		}
		/**
		* Acquires a token by exchanging the Authorization Code received from the first step of OAuth2.0
		* Authorization Code flow.
		*
		* `getAuthCodeUrl(AuthorizationCodeUrlRequest)` can be used to create the URL for the first step of OAuth2.0
		* Authorization Code flow. Ensure that values for redirectUri and scopes in AuthorizationCodeUrlRequest and
		* AuthorizationCodeRequest are the same.
		*/
		async acquireTokenByCode(request, authCodePayLoad) {
			this.logger.info("acquireTokenByCode called");
			if (request.state && authCodePayLoad) {
				this.logger.info("acquireTokenByCode - validating state");
				this.validateState(request.state, authCodePayLoad.state || "");
				authCodePayLoad = {
					...authCodePayLoad,
					state: ""
				};
			}
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request),
				authenticationScheme: AuthenticationScheme.BEARER
			};
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenByCode, validRequest.correlationId);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const authorizationCodeClient = new AuthorizationCodeClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, validRequest.redirectUri, serverTelemetryManager));
				this.logger.verbose("Auth code client created", validRequest.correlationId);
				return await authorizationCodeClient.acquireToken(validRequest, ApiId.acquireTokenByCode, authCodePayLoad);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(e);
				throw e;
			}
		}
		/**
		* Acquires a token by exchanging the refresh token provided for a new set of tokens.
		*
		* This API is provided only for scenarios where you would like to migrate from ADAL to MSAL. Otherwise, it is
		* recommended that you use `acquireTokenSilent()` for silent scenarios. When using `acquireTokenSilent()`, MSAL will
		* handle the caching and refreshing of tokens automatically.
		*/
		async acquireTokenByRefreshToken(request) {
			this.logger.info("acquireTokenByRefreshToken called", request.correlationId);
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request),
				authenticationScheme: AuthenticationScheme.BEARER
			};
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenByRefreshToken, validRequest.correlationId);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const refreshTokenClient = new RefreshTokenClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, validRequest.redirectUri || "", serverTelemetryManager));
				this.logger.verbose("Refresh token client created", validRequest.correlationId);
				return await refreshTokenClient.acquireToken(validRequest, ApiId.acquireTokenByRefreshToken);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(e);
				throw e;
			}
		}
		/**
		* Acquires a token silently when a user specifies the account the token is requested for.
		*
		* This API expects the user to provide an account object and looks into the cache to retrieve the token if present.
		* There is also an optional "forceRefresh" boolean the user can send to bypass the cache for access_token and id_token.
		* In case the refresh_token is expired or not found, an error is thrown
		* and the guidance is for the user to call any interactive token acquisition API (eg: `acquireTokenByCode()`).
		*/
		async acquireTokenSilent(request) {
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request),
				forceRefresh: request.forceRefresh || false
			};
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenSilent, validRequest.correlationId, validRequest.forceRefresh);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const clientConfiguration = await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, validRequest.redirectUri || "", serverTelemetryManager);
				const silentFlowClient = new SilentFlowClient(clientConfiguration);
				this.logger.verbose("Silent flow client created", validRequest.correlationId);
				try {
					await this.tokenCache.overwriteCache();
					return await this.acquireCachedTokenSilent(validRequest, silentFlowClient, clientConfiguration);
				} catch (error) {
					if (error instanceof ClientAuthError && error.errorCode === tokenRefreshRequired) return new RefreshTokenClient(clientConfiguration).acquireTokenByRefreshToken(validRequest, ApiId.acquireTokenSilent);
					throw error;
				}
			} catch (error) {
				if (error instanceof AuthError) error.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(error);
				throw error;
			}
		}
		async acquireCachedTokenSilent(validRequest, silentFlowClient, clientConfiguration) {
			const [authResponse, cacheOutcome] = await silentFlowClient.acquireCachedToken({
				...validRequest,
				scopes: validRequest.scopes?.length ? validRequest.scopes : [...OIDC_DEFAULT_SCOPES]
			});
			if (cacheOutcome === CacheOutcome.PROACTIVELY_REFRESHED) {
				this.logger.info("ClientApplication:acquireCachedTokenSilent - Cached access token's refreshOn property has been exceeded'. It's not expired, but must be refreshed.");
				const refreshTokenClient = new RefreshTokenClient(clientConfiguration);
				try {
					await refreshTokenClient.acquireTokenByRefreshToken(validRequest, ApiId.acquireTokenSilent);
				} catch {}
			}
			return authResponse;
		}
		/**
		* Acquires tokens with password grant by exchanging client applications username and password for credentials
		*
		* The latest OAuth 2.0 Security Best Current Practice disallows the password grant entirely.
		* More details on this recommendation at https://tools.ietf.org/html/draft-ietf-oauth-security-topics-13#section-3.4
		* Microsoft's documentation and recommendations are at:
		* https://docs.microsoft.com/en-us/azure/active-directory/develop/msal-authentication-flows#usernamepassword
		*
		* @param request - UsenamePasswordRequest
		* @deprecated - Use a more secure flow instead
		*/
		async acquireTokenByUsernamePassword(request) {
			this.logger.info("acquireTokenByUsernamePassword called", request.correlationId);
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request)
			};
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenByUsernamePassword, validRequest.correlationId);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const usernamePasswordClient = new UsernamePasswordClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, "", serverTelemetryManager));
				this.logger.verbose("Username password client created", validRequest.correlationId);
				return await usernamePasswordClient.acquireToken(validRequest);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(e);
				throw e;
			}
		}
		/**
		* Gets the token cache for the application.
		*/
		getTokenCache() {
			this.logger.info("getTokenCache called");
			return this.tokenCache;
		}
		/**
		* Validates OIDC state by comparing the user cached state with the state received from the server.
		*
		* This API is provided for scenarios where you would use OAuth2.0 state parameter to mitigate against
		* CSRF attacks.
		* For more information about state, visit https://datatracker.ietf.org/doc/html/rfc6819#section-3.6.
		* @param state - Unique GUID generated by the user that is cached by the user and sent to the server during the first leg of the flow
		* @param cachedState - This string is sent back by the server with the authorization code
		*/
		validateState(state, cachedState) {
			if (!state) throw NodeAuthError.createStateNotFoundError();
			if (state !== cachedState) throw createClientAuthError(stateMismatch);
		}
		/**
		* Returns the logger instance
		*/
		getLogger() {
			return this.logger;
		}
		/**
		* Replaces the default logger set in configurations with new Logger with new configurations
		* @param logger - Logger instance
		*/
		setLogger(logger) {
			this.logger = logger;
		}
		/**
		* Builds the common configuration to be passed to the common component based on the platform configurarion
		* @param authority - user passed authority in configuration
		* @param serverTelemetryManager - initializes servertelemetry if passed
		*/
		async buildOauthClientConfiguration(discoveredAuthority, requestCorrelationId, redirectUri, serverTelemetryManager) {
			this.logger.verbose("buildOauthClientConfiguration called", requestCorrelationId);
			this.logger.info(`Building oauth client configuration with the following authority: ${discoveredAuthority.tokenEndpoint}.`, requestCorrelationId);
			serverTelemetryManager?.updateRegionDiscoveryMetadata(discoveredAuthority.regionDiscoveryMetadata);
			return {
				authOptions: {
					clientId: this.config.auth.clientId,
					authority: discoveredAuthority,
					clientCapabilities: this.config.auth.clientCapabilities,
					redirectUri
				},
				loggerOptions: {
					logLevel: this.config.system.loggerOptions.logLevel,
					loggerCallback: this.config.system.loggerOptions.loggerCallback,
					piiLoggingEnabled: this.config.system.loggerOptions.piiLoggingEnabled,
					correlationId: requestCorrelationId
				},
				cacheOptions: { claimsBasedCachingEnabled: this.config.cache.claimsBasedCachingEnabled },
				cryptoInterface: this.cryptoProvider,
				networkInterface: this.config.system.networkClient,
				storageInterface: this.storage,
				serverTelemetryManager,
				clientCredentials: {
					clientSecret: this.clientSecret,
					clientAssertion: await this.getClientAssertion(discoveredAuthority)
				},
				libraryInfo: {
					sku: Constants.MSAL_SKU,
					version,
					cpu: process.arch || Constants$1.EMPTY_STRING,
					os: process.platform || Constants$1.EMPTY_STRING
				},
				telemetry: this.config.telemetry,
				persistencePlugin: this.config.cache.cachePlugin,
				serializableCache: this.tokenCache
			};
		}
		async getClientAssertion(authority) {
			if (this.developerProvidedClientAssertion) this.clientAssertion = ClientAssertion.fromAssertion(await getClientAssertion(this.developerProvidedClientAssertion, this.config.auth.clientId, authority.tokenEndpoint));
			return this.clientAssertion && {
				assertion: this.clientAssertion.getJwt(this.cryptoProvider, this.config.auth.clientId, authority.tokenEndpoint),
				assertionType: Constants.JWT_BEARER_ASSERTION_TYPE
			};
		}
		/**
		* Generates a request with the default scopes & generates a correlationId.
		* @param authRequest - BaseAuthRequest for initialization
		*/
		async initializeBaseRequest(authRequest) {
			this.logger.verbose("initializeRequestScopes called", authRequest.correlationId);
			if (authRequest.authenticationScheme && authRequest.authenticationScheme === AuthenticationScheme.POP) this.logger.verbose("Authentication Scheme 'pop' is not supported yet, setting Authentication Scheme to 'Bearer' for request", authRequest.correlationId);
			authRequest.authenticationScheme = AuthenticationScheme.BEARER;
			if (this.config.cache.claimsBasedCachingEnabled && authRequest.claims && !StringUtils.isEmptyObj(authRequest.claims)) authRequest.requestedClaimsHash = await this.cryptoProvider.hashString(authRequest.claims);
			return {
				...authRequest,
				scopes: [...authRequest && authRequest.scopes || [], ...OIDC_DEFAULT_SCOPES],
				correlationId: authRequest && authRequest.correlationId || this.cryptoProvider.createNewGuid(),
				authority: authRequest.authority || this.config.auth.authority
			};
		}
		/**
		* Initializes the server telemetry payload
		* @param apiId - Id for a specific request
		* @param correlationId - GUID
		* @param forceRefresh - boolean to indicate network call
		*/
		initializeServerTelemetryManager(apiId, correlationId, forceRefresh) {
			return new ServerTelemetryManager({
				clientId: this.config.auth.clientId,
				correlationId,
				apiId,
				forceRefresh: forceRefresh || false
			}, this.storage);
		}
		/**
		* Create authority instance. If authority not passed in request, default to authority set on the application
		* object. If no authority set in application object, then default to common authority.
		* @param authorityString - authority from user configuration
		*/
		async createAuthority(authorityString, requestCorrelationId, azureRegionConfiguration, azureCloudOptions) {
			this.logger.verbose("createAuthority called", requestCorrelationId);
			const authorityUrl = Authority.generateAuthority(authorityString, azureCloudOptions || this.config.auth.azureCloudOptions);
			const authorityOptions = {
				protocolMode: this.config.auth.protocolMode,
				knownAuthorities: this.config.auth.knownAuthorities,
				cloudDiscoveryMetadata: this.config.auth.cloudDiscoveryMetadata,
				authorityMetadata: this.config.auth.authorityMetadata,
				azureRegionConfiguration,
				skipAuthorityMetadataCache: this.config.auth.skipAuthorityMetadataCache
			};
			return createDiscoveredInstance(authorityUrl, this.config.system.networkClient, this.storage, authorityOptions, this.logger, requestCorrelationId);
		}
		/**
		* Clear the cache
		*/
		clearCache() {
			this.storage.clear();
		}
	};
	var LoopbackClient = class {
		/**
		* Spins up a loopback server which returns the server response when the localhost redirectUri is hit
		* @param successTemplate
		* @param errorTemplate
		* @returns
		*/
		async listenForAuthCode(successTemplate, errorTemplate) {
			if (this.server) throw NodeAuthError.createLoopbackServerAlreadyExistsError();
			return new Promise((resolve, reject) => {
				this.server = http.createServer((req, res) => {
					const url = req.url;
					if (!url) {
						res.end(errorTemplate || "Error occurred loading redirectUrl");
						reject(NodeAuthError.createUnableToLoadRedirectUrlError());
						return;
					} else if (url === Constants$1.FORWARD_SLASH) {
						res.end(successTemplate || "Auth code was successfully acquired. You can close this window now.");
						return;
					}
					const redirectUri = this.getRedirectUri();
					const authCodeResponse = getDeserializedResponse(new URL(url, redirectUri).search) || {};
					if (authCodeResponse.code) {
						res.writeHead(HttpStatus.REDIRECT, { location: redirectUri });
						res.end();
					}
					if (authCodeResponse.error) res.end(errorTemplate || `Error occurred: ${authCodeResponse.error}`);
					resolve(authCodeResponse);
				});
				this.server.listen(0, "127.0.0.1");
			});
		}
		/**
		* Get the port that the loopback server is running on
		* @returns
		*/
		getRedirectUri() {
			if (!this.server || !this.server.listening) throw NodeAuthError.createNoLoopbackServerExistsError();
			const address = this.server.address();
			if (!address || typeof address === "string" || !address.port) {
				this.closeServer();
				throw NodeAuthError.createInvalidLoopbackAddressTypeError();
			}
			const port = address && address.port;
			return `${Constants.HTTP_PROTOCOL}${Constants.LOCALHOST}:${port}`;
		}
		/**
		* Close the loopback server
		*/
		closeServer() {
			if (this.server) {
				this.server.close();
				if (typeof this.server.closeAllConnections === "function") this.server.closeAllConnections();
				this.server.unref();
				this.server = void 0;
			}
		}
	};
	/**
	* OAuth2.0 Device code client
	* @public
	*/
	var DeviceCodeClient = class extends BaseClient {
		constructor(configuration) {
			super(configuration);
		}
		/**
		* Gets device code from device code endpoint, calls back to with device code response, and
		* polls token endpoint to exchange device code for tokens
		* @param request - developer provided CommonDeviceCodeRequest
		*/
		async acquireToken(request) {
			const deviceCodeResponse = await this.getDeviceCode(request);
			request.deviceCodeCallback(deviceCodeResponse);
			const reqTimestamp = nowSeconds();
			const response = await this.acquireTokenWithDeviceCode(request, deviceCodeResponse);
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(response);
			return responseHandler.handleServerTokenResponse(response, this.authority, reqTimestamp, request, ApiId.acquireTokenByDeviceCode);
		}
		/**
		* Creates device code request and executes http GET
		* @param request - developer provided CommonDeviceCodeRequest
		*/
		async getDeviceCode(request) {
			const queryParametersString = this.createExtraQueryParameters(request);
			const endpoint = UrlString.appendQueryString(this.authority.deviceCodeEndpoint, queryParametersString);
			const queryString = this.createQueryString(request);
			const headers = this.createTokenRequestHeaders();
			const thumbprint = {
				clientId: this.config.authOptions.clientId,
				authority: request.authority,
				scopes: request.scopes,
				claims: request.claims,
				authenticationScheme: request.authenticationScheme,
				resourceRequestMethod: request.resourceRequestMethod,
				resourceRequestUri: request.resourceRequestUri,
				shrClaims: request.shrClaims,
				sshKid: request.sshKid
			};
			return this.executePostRequestToDeviceCodeEndpoint(endpoint, queryString, headers, thumbprint, request.correlationId);
		}
		/**
		* Creates query string for the device code request
		* @param request - developer provided CommonDeviceCodeRequest
		*/
		createExtraQueryParameters(request) {
			const parameters = /* @__PURE__ */ new Map();
			if (request.extraQueryParameters) addExtraQueryParameters(parameters, request.extraQueryParameters);
			return mapToQueryString(parameters);
		}
		/**
		* Executes POST request to device code endpoint
		* @param deviceCodeEndpoint - token endpoint
		* @param queryString - string to be used in the body of the request
		* @param headers - headers for the request
		* @param thumbprint - unique request thumbprint
		* @param correlationId - correlation id to be used in the request
		*/
		async executePostRequestToDeviceCodeEndpoint(deviceCodeEndpoint, queryString, headers, thumbprint, correlationId) {
			const { body: { user_code: userCode, device_code: deviceCode, verification_uri: verificationUri, expires_in: expiresIn, interval, message } } = await this.sendPostRequest(thumbprint, deviceCodeEndpoint, {
				body: queryString,
				headers
			}, correlationId);
			return {
				userCode,
				deviceCode,
				verificationUri,
				expiresIn,
				interval,
				message
			};
		}
		/**
		* Create device code endpoint query parameters and returns string
		* @param request - developer provided CommonDeviceCodeRequest
		*/
		createQueryString(request) {
			const parameters = /* @__PURE__ */ new Map();
			addScopes(parameters, request.scopes);
			addClientId(parameters, this.config.authOptions.clientId);
			if (request.extraQueryParameters) addExtraQueryParameters(parameters, request.extraQueryParameters);
			if (request.claims || this.config.authOptions.clientCapabilities && this.config.authOptions.clientCapabilities.length > 0) addClaims(parameters, request.claims, this.config.authOptions.clientCapabilities);
			return mapToQueryString(parameters);
		}
		/**
		* Breaks the polling with specific conditions
		* @param deviceCodeExpirationTime - expiration time for the device code request
		* @param userSpecifiedTimeout - developer provided timeout, to be compared against deviceCodeExpirationTime
		* @param userSpecifiedCancelFlag - boolean indicating the developer would like to cancel the request
		*/
		continuePolling(deviceCodeExpirationTime, userSpecifiedTimeout, userSpecifiedCancelFlag) {
			if (userSpecifiedCancelFlag) {
				this.logger.error("Token request cancelled by setting DeviceCodeRequest.cancel = true");
				throw createClientAuthError(deviceCodePollingCancelled);
			} else if (userSpecifiedTimeout && userSpecifiedTimeout < deviceCodeExpirationTime && nowSeconds() > userSpecifiedTimeout) {
				this.logger.error(`User defined timeout for device code polling reached. The timeout was set for ${userSpecifiedTimeout}`);
				throw createClientAuthError(userTimeoutReached);
			} else if (nowSeconds() > deviceCodeExpirationTime) {
				if (userSpecifiedTimeout) this.logger.verbose(`User specified timeout ignored as the device code has expired before the timeout elapsed. The user specified timeout was set for ${userSpecifiedTimeout}`);
				this.logger.error(`Device code expired. Expiration time of device code was ${deviceCodeExpirationTime}`);
				throw createClientAuthError(deviceCodeExpired);
			}
			return true;
		}
		/**
		* Creates token request with device code response and polls token endpoint at interval set by the device code response
		* @param request - developer provided CommonDeviceCodeRequest
		* @param deviceCodeResponse - DeviceCodeResponse returned by the security token service device code endpoint
		*/
		async acquireTokenWithDeviceCode(request, deviceCodeResponse) {
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(this.authority.tokenEndpoint, queryParametersString);
			const requestBody = this.createTokenRequestBody(request, deviceCodeResponse);
			const headers = this.createTokenRequestHeaders();
			const userSpecifiedTimeout = request.timeout ? nowSeconds() + request.timeout : void 0;
			const deviceCodeExpirationTime = nowSeconds() + deviceCodeResponse.expiresIn;
			const pollingIntervalMilli = deviceCodeResponse.interval * 1e3;
			while (this.continuePolling(deviceCodeExpirationTime, userSpecifiedTimeout, request.cancel)) {
				const thumbprint = {
					clientId: this.config.authOptions.clientId,
					authority: request.authority,
					scopes: request.scopes,
					claims: request.claims,
					authenticationScheme: request.authenticationScheme,
					resourceRequestMethod: request.resourceRequestMethod,
					resourceRequestUri: request.resourceRequestUri,
					shrClaims: request.shrClaims,
					sshKid: request.sshKid
				};
				const response = await this.executePostToTokenEndpoint(endpoint, requestBody, headers, thumbprint, request.correlationId);
				if (response.body && response.body.error) if (response.body.error === Constants$1.AUTHORIZATION_PENDING) {
					this.logger.info("Authorization pending. Continue polling.");
					await delay(pollingIntervalMilli);
				} else {
					this.logger.info("Unexpected error in polling from the server");
					throw createAuthError(postRequestFailed, response.body.error);
				}
				else {
					this.logger.verbose("Authorization completed successfully. Polling stopped.");
					return response.body;
				}
			}
			this.logger.error("Polling stopped for unknown reasons.");
			throw createClientAuthError(deviceCodeUnknownError);
		}
		/**
		* Creates query parameters and converts to string.
		* @param request - developer provided CommonDeviceCodeRequest
		* @param deviceCodeResponse - DeviceCodeResponse returned by the security token service device code endpoint
		*/
		createTokenRequestBody(request, deviceCodeResponse) {
			const parameters = /* @__PURE__ */ new Map();
			addScopes(parameters, request.scopes);
			addClientId(parameters, this.config.authOptions.clientId);
			addGrantType(parameters, GrantType.DEVICE_CODE_GRANT);
			addDeviceCode(parameters, deviceCodeResponse.deviceCode);
			addCorrelationId(parameters, request.correlationId || this.config.cryptoInterface.createNewGuid());
			addClientInfo(parameters);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager) addServerTelemetry(parameters, this.serverTelemetryManager);
			if (!StringUtils.isEmptyObj(request.claims) || this.config.authOptions.clientCapabilities && this.config.authOptions.clientCapabilities.length > 0) addClaims(parameters, request.claims, this.config.authOptions.clientCapabilities);
			return mapToQueryString(parameters);
		}
	};
	/**
	* This class is to be used to acquire tokens for public client applications (desktop, mobile). Public client applications
	* are not trusted to safely store application secrets, and therefore can only request tokens in the name of an user.
	* @public
	*/
	var PublicClientApplication = class extends ClientApplication {
		/**
		* Important attributes in the Configuration object for auth are:
		* - clientID: the application ID of your application. You can obtain one by registering your application with our Application registration portal.
		* - authority: the authority URL for your application.
		*
		* AAD authorities are of the form https://login.microsoftonline.com/\{Enter_the_Tenant_Info_Here\}.
		* - If your application supports Accounts in one organizational directory, replace "Enter_the_Tenant_Info_Here" value with the Tenant Id or Tenant name (for example, contoso.microsoft.com).
		* - If your application supports Accounts in any organizational directory, replace "Enter_the_Tenant_Info_Here" value with organizations.
		* - If your application supports Accounts in any organizational directory and personal Microsoft accounts, replace "Enter_the_Tenant_Info_Here" value with common.
		* - To restrict support to Personal Microsoft accounts only, replace "Enter_the_Tenant_Info_Here" value with consumers.
		*
		* Azure B2C authorities are of the form https://\{instance\}/\{tenant\}/\{policy\}. Each policy is considered
		* its own authority. You will have to set the all of the knownAuthorities at the time of the client application
		* construction.
		*
		* ADFS authorities are of the form https://\{instance\}/adfs.
		*/
		constructor(configuration) {
			super(configuration);
			if (this.config.broker.nativeBrokerPlugin) if (this.config.broker.nativeBrokerPlugin.isBrokerAvailable) {
				this.nativeBrokerPlugin = this.config.broker.nativeBrokerPlugin;
				this.nativeBrokerPlugin.setLogger(this.config.system.loggerOptions);
			} else this.logger.warning("NativeBroker implementation was provided but the broker is unavailable.");
			this.skus = ServerTelemetryManager.makeExtraSkuString({
				libraryName: Constants.MSAL_SKU,
				libraryVersion: version
			});
		}
		/**
		* Acquires a token from the authority using OAuth2.0 device code flow.
		* This flow is designed for devices that do not have access to a browser or have input constraints.
		* The authorization server issues a DeviceCode object with a verification code, an end-user code,
		* and the end-user verification URI. The DeviceCode object is provided through a callback, and the end-user should be
		* instructed to use another device to navigate to the verification URI to input credentials.
		* Since the client cannot receive incoming requests, it polls the authorization server repeatedly
		* until the end-user completes input of credentials.
		*/
		async acquireTokenByDeviceCode(request) {
			this.logger.info("acquireTokenByDeviceCode called", request.correlationId);
			const validRequest = Object.assign(request, await this.initializeBaseRequest(request));
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenByDeviceCode, validRequest.correlationId);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const deviceCodeClient = new DeviceCodeClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, "", serverTelemetryManager));
				this.logger.verbose("Device code client created", validRequest.correlationId);
				return await deviceCodeClient.acquireToken(validRequest);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(e);
				throw e;
			}
		}
		/**
		* Acquires a token interactively via the browser by requesting an authorization code then exchanging it for a token.
		*/
		async acquireTokenInteractive(request) {
			const correlationId = request.correlationId || this.cryptoProvider.createNewGuid();
			this.logger.trace("acquireTokenInteractive called", correlationId);
			const { openBrowser, successTemplate, errorTemplate, windowHandle, loopbackClient: customLoopbackClient, ...remainingProperties } = request;
			if (this.nativeBrokerPlugin) {
				const brokerRequest = {
					...remainingProperties,
					clientId: this.config.auth.clientId,
					scopes: request.scopes || OIDC_DEFAULT_SCOPES,
					redirectUri: request.redirectUri || "",
					authority: request.authority || this.config.auth.authority,
					correlationId,
					extraParameters: {
						...remainingProperties.extraQueryParameters,
						...remainingProperties.tokenQueryParameters,
						[X_CLIENT_EXTRA_SKU]: this.skus
					},
					accountId: remainingProperties.account?.nativeAccountId
				};
				return this.nativeBrokerPlugin.acquireTokenInteractive(brokerRequest, windowHandle);
			}
			if (request.redirectUri) {
				if (!this.config.broker.nativeBrokerPlugin) throw NodeAuthError.createRedirectUriNotSupportedError();
				request.redirectUri = "";
			}
			const { verifier, challenge } = await this.cryptoProvider.generatePkceCodes();
			const loopbackClient = customLoopbackClient || new LoopbackClient();
			let authCodeResponse = {};
			let authCodeListenerError = null;
			try {
				const authCodeListener = loopbackClient.listenForAuthCode(successTemplate, errorTemplate).then((response) => {
					authCodeResponse = response;
				}).catch((e) => {
					authCodeListenerError = e;
				});
				const redirectUri = await this.waitForRedirectUri(loopbackClient);
				const validRequest = {
					...remainingProperties,
					correlationId,
					scopes: request.scopes || OIDC_DEFAULT_SCOPES,
					redirectUri,
					responseMode: ResponseMode.QUERY,
					codeChallenge: challenge,
					codeChallengeMethod: CodeChallengeMethodValues.S256
				};
				await openBrowser(await this.getAuthCodeUrl(validRequest));
				await authCodeListener;
				if (authCodeListenerError) throw authCodeListenerError;
				if (authCodeResponse.error) throw new ServerError(authCodeResponse.error, authCodeResponse.error_description, authCodeResponse.suberror);
				else if (!authCodeResponse.code) throw NodeAuthError.createNoAuthCodeInResponseError();
				const clientInfo = authCodeResponse.client_info;
				const tokenRequest = {
					code: authCodeResponse.code,
					codeVerifier: verifier,
					clientInfo: clientInfo || Constants$1.EMPTY_STRING,
					...validRequest
				};
				return await this.acquireTokenByCode(tokenRequest);
			} finally {
				loopbackClient.closeServer();
			}
		}
		/**
		* Returns a token retrieved either from the cache or by exchanging the refresh token for a fresh access token. If brokering is enabled the token request will be serviced by the broker.
		* @param request - developer provided SilentFlowRequest
		* @returns
		*/
		async acquireTokenSilent(request) {
			const correlationId = request.correlationId || this.cryptoProvider.createNewGuid();
			this.logger.trace("acquireTokenSilent called", correlationId);
			if (this.nativeBrokerPlugin) {
				const brokerRequest = {
					...request,
					clientId: this.config.auth.clientId,
					scopes: request.scopes || OIDC_DEFAULT_SCOPES,
					redirectUri: request.redirectUri || "",
					authority: request.authority || this.config.auth.authority,
					correlationId,
					extraParameters: {
						...request.tokenQueryParameters,
						[X_CLIENT_EXTRA_SKU]: this.skus
					},
					accountId: request.account.nativeAccountId,
					forceRefresh: request.forceRefresh || false
				};
				return this.nativeBrokerPlugin.acquireTokenSilent(brokerRequest);
			}
			if (request.redirectUri) {
				if (!this.config.broker.nativeBrokerPlugin) throw NodeAuthError.createRedirectUriNotSupportedError();
				request.redirectUri = "";
			}
			return super.acquireTokenSilent(request);
		}
		/**
		* Removes cache artifacts associated with the given account
		* @param request - developer provided SignOutRequest
		* @returns
		*/
		async signOut(request) {
			if (this.nativeBrokerPlugin && request.account.nativeAccountId) {
				const signoutRequest = {
					clientId: this.config.auth.clientId,
					accountId: request.account.nativeAccountId,
					correlationId: request.correlationId || this.cryptoProvider.createNewGuid()
				};
				await this.nativeBrokerPlugin.signOut(signoutRequest);
			}
			await this.getTokenCache().removeAccount(request.account, request.correlationId);
		}
		/**
		* Returns all cached accounts for this application. If brokering is enabled this request will be serviced by the broker.
		* @returns
		*/
		async getAllAccounts() {
			if (this.nativeBrokerPlugin) {
				const correlationId = this.cryptoProvider.createNewGuid();
				return this.nativeBrokerPlugin.getAllAccounts(this.config.auth.clientId, correlationId);
			}
			return this.getTokenCache().getAllAccounts();
		}
		/**
		* Attempts to retrieve the redirectUri from the loopback server. If the loopback server does not start listening for requests within the timeout this will throw.
		* @param loopbackClient - developer provided custom loopback server implementation
		* @returns
		*/
		async waitForRedirectUri(loopbackClient) {
			return new Promise((resolve, reject) => {
				let ticks = 0;
				const id = setInterval(() => {
					if (LOOPBACK_SERVER_CONSTANTS.TIMEOUT_MS / LOOPBACK_SERVER_CONSTANTS.INTERVAL_MS < ticks) {
						clearInterval(id);
						reject(NodeAuthError.createLoopbackServerTimeoutError());
						return;
					}
					try {
						const r = loopbackClient.getRedirectUri();
						clearInterval(id);
						resolve(r);
						return;
					} catch (e) {
						if (e instanceof AuthError && e.errorCode === NodeAuthErrorMessage.noLoopbackServerExists.code) {
							ticks++;
							return;
						}
						clearInterval(id);
						reject(e);
						return;
					}
				}, LOOPBACK_SERVER_CONSTANTS.INTERVAL_MS);
			});
		}
	};
	/**
	* OAuth2.0 client credential grant
	* @public
	*/
	var ClientCredentialClient = class extends BaseClient {
		constructor(configuration, appTokenProvider) {
			super(configuration);
			this.appTokenProvider = appTokenProvider;
		}
		/**
		* Public API to acquire a token with ClientCredential Flow for Confidential clients
		* @param request - CommonClientCredentialRequest provided by the developer
		*/
		async acquireToken(request) {
			if (request.skipCache || request.claims) return this.executeTokenRequest(request, this.authority);
			const [cachedAuthenticationResult, lastCacheOutcome] = await this.getCachedAuthenticationResult(request, this.config, this.cryptoUtils, this.authority, this.cacheManager, this.serverTelemetryManager);
			if (cachedAuthenticationResult) {
				if (lastCacheOutcome === CacheOutcome.PROACTIVELY_REFRESHED) {
					this.logger.info("ClientCredentialClient:getCachedAuthenticationResult - Cached access token's refreshOn property has been exceeded'. It's not expired, but must be refreshed.");
					await this.executeTokenRequest(request, this.authority, true);
				}
				return cachedAuthenticationResult;
			} else return this.executeTokenRequest(request, this.authority);
		}
		/**
		* looks up cache if the tokens are cached already
		*/
		async getCachedAuthenticationResult(request, config, cryptoUtils, authority, cacheManager, serverTelemetryManager) {
			const clientConfiguration = config;
			const managedIdentityConfiguration = config;
			let lastCacheOutcome = CacheOutcome.NOT_APPLICABLE;
			let cacheContext;
			if (clientConfiguration.serializableCache && clientConfiguration.persistencePlugin) {
				cacheContext = new TokenCacheContext(clientConfiguration.serializableCache, false);
				await clientConfiguration.persistencePlugin.beforeCacheAccess(cacheContext);
			}
			const cachedAccessToken = this.readAccessTokenFromCache(authority, managedIdentityConfiguration.managedIdentityId?.id || clientConfiguration.authOptions.clientId, new ScopeSet(request.scopes || []), cacheManager, request.correlationId);
			if (clientConfiguration.serializableCache && clientConfiguration.persistencePlugin && cacheContext) await clientConfiguration.persistencePlugin.afterCacheAccess(cacheContext);
			if (!cachedAccessToken) {
				serverTelemetryManager?.setCacheOutcome(CacheOutcome.NO_CACHED_ACCESS_TOKEN);
				return [null, CacheOutcome.NO_CACHED_ACCESS_TOKEN];
			}
			if (isTokenExpired(cachedAccessToken.expiresOn, clientConfiguration.systemOptions?.tokenRenewalOffsetSeconds || DEFAULT_TOKEN_RENEWAL_OFFSET_SEC)) {
				serverTelemetryManager?.setCacheOutcome(CacheOutcome.CACHED_ACCESS_TOKEN_EXPIRED);
				return [null, CacheOutcome.CACHED_ACCESS_TOKEN_EXPIRED];
			}
			if (cachedAccessToken.refreshOn && isTokenExpired(cachedAccessToken.refreshOn.toString(), 0)) {
				lastCacheOutcome = CacheOutcome.PROACTIVELY_REFRESHED;
				serverTelemetryManager?.setCacheOutcome(CacheOutcome.PROACTIVELY_REFRESHED);
			}
			return [await ResponseHandler.generateAuthenticationResult(cryptoUtils, authority, {
				account: null,
				idToken: null,
				accessToken: cachedAccessToken,
				refreshToken: null,
				appMetadata: null
			}, true, request), lastCacheOutcome];
		}
		/**
		* Reads access token from the cache
		*/
		readAccessTokenFromCache(authority, id, scopeSet, cacheManager, correlationId) {
			const accessTokenFilter = {
				homeAccountId: Constants$1.EMPTY_STRING,
				environment: authority.canonicalAuthorityUrlComponents.HostNameAndPort,
				credentialType: CredentialType.ACCESS_TOKEN,
				clientId: id,
				realm: authority.tenant,
				target: ScopeSet.createSearchScopes(scopeSet.asArray())
			};
			const accessTokens = cacheManager.getAccessTokensByFilter(accessTokenFilter, correlationId);
			if (accessTokens.length < 1) return null;
			else if (accessTokens.length > 1) throw createClientAuthError(multipleMatchingTokens);
			return accessTokens[0];
		}
		/**
		* Makes a network call to request the token from the service
		* @param request - CommonClientCredentialRequest provided by the developer
		* @param authority - authority object
		*/
		async executeTokenRequest(request, authority, refreshAccessToken) {
			let serverTokenResponse;
			let reqTimestamp;
			if (this.appTokenProvider) {
				this.logger.info("Using appTokenProvider extensibility.");
				const appTokenPropviderParameters = {
					correlationId: request.correlationId,
					tenantId: this.config.authOptions.authority.tenant,
					scopes: request.scopes,
					claims: request.claims
				};
				reqTimestamp = nowSeconds();
				const appTokenProviderResult = await this.appTokenProvider(appTokenPropviderParameters);
				serverTokenResponse = {
					access_token: appTokenProviderResult.accessToken,
					expires_in: appTokenProviderResult.expiresInSeconds,
					refresh_in: appTokenProviderResult.refreshInSeconds,
					token_type: AuthenticationScheme.BEARER
				};
			} else {
				const queryParametersString = this.createTokenQueryParameters(request);
				const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
				const requestBody = await this.createTokenRequestBody(request);
				const headers = this.createTokenRequestHeaders();
				const thumbprint = {
					clientId: this.config.authOptions.clientId,
					authority: request.authority,
					scopes: request.scopes,
					claims: request.claims,
					authenticationScheme: request.authenticationScheme,
					resourceRequestMethod: request.resourceRequestMethod,
					resourceRequestUri: request.resourceRequestUri,
					shrClaims: request.shrClaims,
					sshKid: request.sshKid
				};
				this.logger.info("Sending token request to endpoint: " + authority.tokenEndpoint);
				reqTimestamp = nowSeconds();
				const response = await this.executePostToTokenEndpoint(endpoint, requestBody, headers, thumbprint, request.correlationId);
				serverTokenResponse = response.body;
				serverTokenResponse.status = response.status;
			}
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(serverTokenResponse, refreshAccessToken);
			return await responseHandler.handleServerTokenResponse(serverTokenResponse, this.authority, reqTimestamp, request, ApiId.acquireTokenByClientCredential);
		}
		/**
		* generate the request to the server in the acceptable format
		* @param request - CommonClientCredentialRequest provided by the developer
		*/
		async createTokenRequestBody(request) {
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, this.config.authOptions.clientId);
			addScopes(parameters, request.scopes, false);
			addGrantType(parameters, GrantType.CLIENT_CREDENTIALS_GRANT);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager) addServerTelemetry(parameters, this.serverTelemetryManager);
			addCorrelationId(parameters, request.correlationId || this.config.cryptoInterface.createNewGuid());
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			const clientAssertion = request.clientAssertion || this.config.clientCredentials.clientAssertion;
			if (clientAssertion) {
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			if (!StringUtils.isEmptyObj(request.claims) || this.config.authOptions.clientCapabilities && this.config.authOptions.clientCapabilities.length > 0) addClaims(parameters, request.claims, this.config.authOptions.clientCapabilities);
			return mapToQueryString(parameters);
		}
	};
	/**
	* On-Behalf-Of client
	* @public
	*/
	var OnBehalfOfClient = class extends BaseClient {
		constructor(configuration) {
			super(configuration);
		}
		/**
		* Public API to acquire tokens with on behalf of flow
		* @param request - developer provided CommonOnBehalfOfRequest
		*/
		async acquireToken(request) {
			this.scopeSet = new ScopeSet(request.scopes || []);
			this.userAssertionHash = await this.cryptoUtils.hashString(request.oboAssertion);
			if (request.skipCache || request.claims) return this.executeTokenRequest(request, this.authority, this.userAssertionHash);
			try {
				return await this.getCachedAuthenticationResult(request);
			} catch (e) {
				return await this.executeTokenRequest(request, this.authority, this.userAssertionHash);
			}
		}
		/**
		* look up cache for tokens
		* Find idtoken in the cache
		* Find accessToken based on user assertion and account info in the cache
		* Please note we are not yet supported OBO tokens refreshed with long lived RT. User will have to send a new assertion if the current access token expires
		* This is to prevent security issues when the assertion changes over time, however, longlived RT helps retaining the session
		* @param request - developer provided CommonOnBehalfOfRequest
		*/
		async getCachedAuthenticationResult(request) {
			const cachedAccessToken = this.readAccessTokenFromCacheForOBO(this.config.authOptions.clientId, request);
			if (!cachedAccessToken) {
				this.serverTelemetryManager?.setCacheOutcome(CacheOutcome.NO_CACHED_ACCESS_TOKEN);
				this.logger.info("SilentFlowClient:acquireCachedToken - No access token found in cache for the given properties.");
				throw createClientAuthError(tokenRefreshRequired);
			} else if (isTokenExpired(cachedAccessToken.expiresOn, this.config.systemOptions.tokenRenewalOffsetSeconds)) {
				this.serverTelemetryManager?.setCacheOutcome(CacheOutcome.CACHED_ACCESS_TOKEN_EXPIRED);
				this.logger.info(`OnbehalfofFlow:getCachedAuthenticationResult - Cached access token is expired or will expire within ${this.config.systemOptions.tokenRenewalOffsetSeconds} seconds.`);
				throw createClientAuthError(tokenRefreshRequired);
			}
			const cachedIdToken = this.readIdTokenFromCacheForOBO(cachedAccessToken.homeAccountId, request.correlationId);
			let idTokenClaims;
			let cachedAccount = null;
			if (cachedIdToken) {
				idTokenClaims = extractTokenClaims(cachedIdToken.secret, EncodingUtils.base64Decode);
				const localAccountId = idTokenClaims.oid || idTokenClaims.sub;
				const accountInfo = {
					homeAccountId: cachedIdToken.homeAccountId,
					environment: cachedIdToken.environment,
					tenantId: cachedIdToken.realm,
					username: Constants$1.EMPTY_STRING,
					localAccountId: localAccountId || Constants$1.EMPTY_STRING
				};
				cachedAccount = this.cacheManager.getAccount(this.cacheManager.generateAccountKey(accountInfo), request.correlationId);
			}
			if (this.config.serverTelemetryManager) this.config.serverTelemetryManager.incrementCacheHits();
			return ResponseHandler.generateAuthenticationResult(this.cryptoUtils, this.authority, {
				account: cachedAccount,
				accessToken: cachedAccessToken,
				idToken: cachedIdToken,
				refreshToken: null,
				appMetadata: null
			}, true, request, idTokenClaims);
		}
		/**
		* read idtoken from cache, this is a specific implementation for OBO as the requirements differ from a generic lookup in the cacheManager
		* Certain use cases of OBO flow do not expect an idToken in the cache/or from the service
		* @param atHomeAccountId - account id
		*/
		readIdTokenFromCacheForOBO(atHomeAccountId, correlationId) {
			const idTokenFilter = {
				homeAccountId: atHomeAccountId,
				environment: this.authority.canonicalAuthorityUrlComponents.HostNameAndPort,
				credentialType: CredentialType.ID_TOKEN,
				clientId: this.config.authOptions.clientId,
				realm: this.authority.tenant
			};
			const idTokenMap = this.cacheManager.getIdTokensByFilter(idTokenFilter, correlationId);
			if (Object.values(idTokenMap).length < 1) return null;
			return Object.values(idTokenMap)[0];
		}
		/**
		* Fetches the cached access token based on incoming assertion
		* @param clientId - client id
		* @param request - developer provided CommonOnBehalfOfRequest
		*/
		readAccessTokenFromCacheForOBO(clientId, request) {
			const authScheme = request.authenticationScheme || AuthenticationScheme.BEARER;
			const accessTokenFilter = {
				credentialType: authScheme.toLowerCase() !== AuthenticationScheme.BEARER.toLowerCase() ? CredentialType.ACCESS_TOKEN_WITH_AUTH_SCHEME : CredentialType.ACCESS_TOKEN,
				clientId,
				target: ScopeSet.createSearchScopes(this.scopeSet.asArray()),
				tokenType: authScheme,
				keyId: request.sshKid,
				requestedClaimsHash: request.requestedClaimsHash,
				userAssertionHash: this.userAssertionHash
			};
			const accessTokens = this.cacheManager.getAccessTokensByFilter(accessTokenFilter, request.correlationId);
			const numAccessTokens = accessTokens.length;
			if (numAccessTokens < 1) return null;
			else if (numAccessTokens > 1) throw createClientAuthError(multipleMatchingTokens);
			return accessTokens[0];
		}
		/**
		* Make a network call to the server requesting credentials
		* @param request - developer provided CommonOnBehalfOfRequest
		* @param authority - authority object
		*/
		async executeTokenRequest(request, authority, userAssertionHash) {
			const queryParametersString = this.createTokenQueryParameters(request);
			const endpoint = UrlString.appendQueryString(authority.tokenEndpoint, queryParametersString);
			const requestBody = await this.createTokenRequestBody(request);
			const headers = this.createTokenRequestHeaders();
			const thumbprint = {
				clientId: this.config.authOptions.clientId,
				authority: request.authority,
				scopes: request.scopes,
				claims: request.claims,
				authenticationScheme: request.authenticationScheme,
				resourceRequestMethod: request.resourceRequestMethod,
				resourceRequestUri: request.resourceRequestUri,
				shrClaims: request.shrClaims,
				sshKid: request.sshKid
			};
			const reqTimestamp = nowSeconds();
			const response = await this.executePostToTokenEndpoint(endpoint, requestBody, headers, thumbprint, request.correlationId);
			const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheManager, this.cryptoUtils, this.logger, this.config.serializableCache, this.config.persistencePlugin);
			responseHandler.validateTokenResponse(response.body);
			return await responseHandler.handleServerTokenResponse(response.body, this.authority, reqTimestamp, request, ApiId.acquireTokenByOBO, void 0, userAssertionHash);
		}
		/**
		* generate a server request in accepable format
		* @param request - developer provided CommonOnBehalfOfRequest
		*/
		async createTokenRequestBody(request) {
			const parameters = /* @__PURE__ */ new Map();
			addClientId(parameters, this.config.authOptions.clientId);
			addScopes(parameters, request.scopes);
			addGrantType(parameters, GrantType.JWT_BEARER);
			addClientInfo(parameters);
			addLibraryInfo(parameters, this.config.libraryInfo);
			addApplicationTelemetry(parameters, this.config.telemetry.application);
			addThrottling(parameters);
			if (this.serverTelemetryManager) addServerTelemetry(parameters, this.serverTelemetryManager);
			addCorrelationId(parameters, request.correlationId || this.config.cryptoInterface.createNewGuid());
			addRequestTokenUse(parameters, ON_BEHALF_OF);
			addOboAssertion(parameters, request.oboAssertion);
			if (this.config.clientCredentials.clientSecret) addClientSecret(parameters, this.config.clientCredentials.clientSecret);
			const clientAssertion = this.config.clientCredentials.clientAssertion;
			if (clientAssertion) {
				addClientAssertion(parameters, await getClientAssertion(clientAssertion.assertion, this.config.authOptions.clientId, request.resourceRequestUri));
				addClientAssertionType(parameters, clientAssertion.assertionType);
			}
			if (request.claims || this.config.authOptions.clientCapabilities && this.config.authOptions.clientCapabilities.length > 0) addClaims(parameters, request.claims, this.config.authOptions.clientCapabilities);
			return mapToQueryString(parameters);
		}
	};
	/**
	*  This class is to be used to acquire tokens for confidential client applications (webApp, webAPI). Confidential client applications
	*  will configure application secrets, client certificates/assertions as applicable
	* @public
	*/
	var ConfidentialClientApplication = class extends ClientApplication {
		/**
		* Constructor for the ConfidentialClientApplication
		*
		* Required attributes in the Configuration object are:
		* - clientID: the application ID of your application. You can obtain one by registering your application with our application registration portal
		* - authority: the authority URL for your application.
		* - client credential: Must set either client secret, certificate, or assertion for confidential clients. You can obtain a client secret from the application registration portal.
		*
		* In Azure AD, authority is a URL indicating of the form https://login.microsoftonline.com/\{Enter_the_Tenant_Info_Here\}.
		* If your application supports Accounts in one organizational directory, replace "Enter_the_Tenant_Info_Here" value with the Tenant Id or Tenant name (for example, contoso.microsoft.com).
		* If your application supports Accounts in any organizational directory, replace "Enter_the_Tenant_Info_Here" value with organizations.
		* If your application supports Accounts in any organizational directory and personal Microsoft accounts, replace "Enter_the_Tenant_Info_Here" value with common.
		* To restrict support to Personal Microsoft accounts only, replace "Enter_the_Tenant_Info_Here" value with consumers.
		*
		* In Azure B2C, authority is of the form https://\{instance\}/tfp/\{tenant\}/\{policyName\}/
		* Full B2C functionality will be available in this library in future versions.
		*
		* @param Configuration - configuration object for the MSAL ConfidentialClientApplication instance
		*/
		constructor(configuration) {
			super(configuration);
			const clientSecretNotEmpty = !!this.config.auth.clientSecret;
			const clientAssertionNotEmpty = !!this.config.auth.clientAssertion;
			const certificateNotEmpty = (!!this.config.auth.clientCertificate?.thumbprint || !!this.config.auth.clientCertificate?.thumbprintSha256) && !!this.config.auth.clientCertificate?.privateKey;
			if (this.appTokenProvider) return;
			if (clientSecretNotEmpty && clientAssertionNotEmpty || clientAssertionNotEmpty && certificateNotEmpty || clientSecretNotEmpty && certificateNotEmpty) throw createClientAuthError(invalidClientCredential);
			if (this.config.auth.clientSecret) {
				this.clientSecret = this.config.auth.clientSecret;
				return;
			}
			if (this.config.auth.clientAssertion) {
				this.developerProvidedClientAssertion = this.config.auth.clientAssertion;
				return;
			}
			if (!certificateNotEmpty) throw createClientAuthError(invalidClientCredential);
			else this.clientAssertion = !!this.config.auth.clientCertificate.thumbprintSha256 ? ClientAssertion.fromCertificateWithSha256Thumbprint(this.config.auth.clientCertificate.thumbprintSha256, this.config.auth.clientCertificate.privateKey, this.config.auth.clientCertificate.x5c) : ClientAssertion.fromCertificate(this.config.auth.clientCertificate.thumbprint, this.config.auth.clientCertificate.privateKey, this.config.auth.clientCertificate.x5c);
			this.appTokenProvider = void 0;
		}
		/**
		* This extensibility point only works for the client_credential flow, i.e. acquireTokenByClientCredential and
		* is meant for Azure SDK to enhance Managed Identity support.
		*
		* @param IAppTokenProvider  - Extensibility interface, which allows the app developer to return a token from a custom source.
		*/
		SetAppTokenProvider(provider) {
			this.appTokenProvider = provider;
		}
		/**
		* Acquires tokens from the authority for the application (not for an end user).
		*/
		async acquireTokenByClientCredential(request) {
			this.logger.info("acquireTokenByClientCredential called", request.correlationId);
			let clientAssertion;
			if (request.clientAssertion) clientAssertion = {
				assertion: await getClientAssertion(request.clientAssertion, this.config.auth.clientId),
				assertionType: Constants.JWT_BEARER_ASSERTION_TYPE
			};
			const baseRequest = await this.initializeBaseRequest(request);
			const validBaseRequest = {
				...baseRequest,
				scopes: baseRequest.scopes.filter((scope) => !OIDC_DEFAULT_SCOPES.includes(scope))
			};
			const validRequest = {
				...request,
				...validBaseRequest,
				clientAssertion
			};
			const tenantId = new UrlString(validRequest.authority).getUrlComponents().PathSegments[0];
			if (Object.values(AADAuthorityConstants).includes(tenantId)) throw createClientAuthError(missingTenantIdError);
			const ENV_MSAL_FORCE_REGION = process.env[MSAL_FORCE_REGION];
			let region;
			if (validRequest.azureRegion !== "DisableMsalForceRegion") if (!validRequest.azureRegion && ENV_MSAL_FORCE_REGION) region = ENV_MSAL_FORCE_REGION;
			else region = validRequest.azureRegion;
			const azureRegionConfiguration = {
				azureRegion: region,
				environmentRegion: process.env[REGION_ENVIRONMENT_VARIABLE]
			};
			const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenByClientCredential, validRequest.correlationId, validRequest.skipCache);
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, azureRegionConfiguration, request.azureCloudOptions);
				const clientCredentialClient = new ClientCredentialClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, "", serverTelemetryManager), this.appTokenProvider);
				this.logger.verbose("Client credential client created", validRequest.correlationId);
				return await clientCredentialClient.acquireToken(validRequest);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				serverTelemetryManager.cacheFailedRequest(e);
				throw e;
			}
		}
		/**
		* Acquires tokens from the authority for the application.
		*
		* Used in scenarios where the current app is a middle-tier service which was called with a token
		* representing an end user. The current app can use the token (oboAssertion) to request another
		* token to access downstream web API, on behalf of that user.
		*
		* The current middle-tier app has no user interaction to obtain consent.
		* See how to gain consent upfront for your middle-tier app from this article.
		* https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-on-behalf-of-flow#gaining-consent-for-the-middle-tier-application
		*/
		async acquireTokenOnBehalfOf(request) {
			this.logger.info("acquireTokenOnBehalfOf called", request.correlationId);
			const validRequest = {
				...request,
				...await this.initializeBaseRequest(request)
			};
			try {
				const discoveredAuthority = await this.createAuthority(validRequest.authority, validRequest.correlationId, void 0, request.azureCloudOptions);
				const oboClient = new OnBehalfOfClient(await this.buildOauthClientConfiguration(discoveredAuthority, validRequest.correlationId, "", void 0));
				this.logger.verbose("On behalf of client created", validRequest.correlationId);
				return await oboClient.acquireToken(validRequest);
			} catch (e) {
				if (e instanceof AuthError) e.setCorrelationId(validRequest.correlationId);
				throw e;
			}
		}
	};
	/**
	* @internal
	* Checks if a given date string is in ISO 8601 format.
	*
	* @param dateString - The date string to be checked.
	* @returns boolean - Returns true if the date string is in ISO 8601 format, otherwise false.
	*/
	function isIso8601(dateString) {
		if (typeof dateString !== "string") return false;
		const date = new Date(dateString);
		return !isNaN(date.getTime()) && date.toISOString() === dateString;
	}
	var HttpClientWithRetries = class {
		constructor(httpClientNoRetries, retryPolicy, logger) {
			this.httpClientNoRetries = httpClientNoRetries;
			this.retryPolicy = retryPolicy;
			this.logger = logger;
		}
		async sendNetworkRequestAsyncHelper(httpMethod, url, options) {
			if (httpMethod === HttpMethod.GET) return this.httpClientNoRetries.sendGetRequestAsync(url, options);
			else return this.httpClientNoRetries.sendPostRequestAsync(url, options);
		}
		async sendNetworkRequestAsync(httpMethod, url, options) {
			let response = await this.sendNetworkRequestAsyncHelper(httpMethod, url, options);
			if ("isNewRequest" in this.retryPolicy) this.retryPolicy.isNewRequest = true;
			let currentRetry = 0;
			while (await this.retryPolicy.pauseForRetry(response.status, currentRetry, this.logger, response.headers[HeaderNames.RETRY_AFTER])) {
				response = await this.sendNetworkRequestAsyncHelper(httpMethod, url, options);
				currentRetry++;
			}
			return response;
		}
		async sendGetRequestAsync(url, options) {
			return this.sendNetworkRequestAsync(HttpMethod.GET, url, options);
		}
		async sendPostRequestAsync(url, options) {
			return this.sendNetworkRequestAsync(HttpMethod.POST, url, options);
		}
	};
	/**
	* Managed Identity User Assigned Id Query Parameter Names
	*/
	const ManagedIdentityUserAssignedIdQueryParameterNames = {
		MANAGED_IDENTITY_CLIENT_ID_2017: "clientid",
		MANAGED_IDENTITY_CLIENT_ID: "client_id",
		MANAGED_IDENTITY_OBJECT_ID: "object_id",
		MANAGED_IDENTITY_RESOURCE_ID_IMDS: "msi_res_id",
		MANAGED_IDENTITY_RESOURCE_ID_NON_IMDS: "mi_res_id"
	};
	/**
	* Base class for all Managed Identity sources. Provides common functionality for
	* authenticating with Azure Managed Identity endpoints across different Azure services
	* including IMDS, App Service, Azure Arc, Service Fabric, Cloud Shell, and Machine Learning.
	*
	* This abstract class handles token acquisition, response processing, and network communication
	* while allowing concrete implementations to define source-specific request creation logic.
	*/
	var BaseManagedIdentitySource = class {
		/**
		* Creates an instance of BaseManagedIdentitySource.
		*
		* @param logger - Logger instance for diagnostic information
		* @param nodeStorage - Storage interface for caching tokens
		* @param networkClient - Network client for making HTTP requests
		* @param cryptoProvider - Cryptographic provider for token operations
		* @param disableInternalRetries - Whether to disable automatic retry logic
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) {
			this.logger = logger;
			this.nodeStorage = nodeStorage;
			this.networkClient = networkClient;
			this.cryptoProvider = cryptoProvider;
			this.disableInternalRetries = disableInternalRetries;
		}
		/**
		* Processes the network response and converts it to a standardized server token response.
		* This async version allows for source-specific response processing logic while maintaining
		* backward compatibility with the synchronous version.
		*
		* @param response - The network response containing the managed identity token
		* @param _networkClient - Network client used for the request (unused in base implementation)
		* @param _networkRequest - The original network request parameters (unused in base implementation)
		* @param _networkRequestOptions - The network request options (unused in base implementation)
		*
		* @returns Promise resolving to a standardized server authorization token response
		*/
		async getServerTokenResponseAsync(response, _networkClient, _networkRequest, _networkRequestOptions) {
			return this.getServerTokenResponse(response);
		}
		/**
		* Converts a managed identity token response to a standardized server authorization token response.
		* Handles time format conversion, expiration calculation, and error mapping to ensure
		* compatibility with the MSAL response handling pipeline.
		*
		* @param response - The network response containing the managed identity token
		*
		* @returns Standardized server authorization token response with normalized fields
		*/
		getServerTokenResponse(response) {
			let refreshIn, expiresIn;
			if (response.body.expires_on) {
				if (isIso8601(response.body.expires_on)) response.body.expires_on = new Date(response.body.expires_on).getTime() / 1e3;
				expiresIn = response.body.expires_on - nowSeconds();
				if (expiresIn > 2 * 3600) refreshIn = expiresIn / 2;
			}
			return {
				status: response.status,
				access_token: response.body.access_token,
				expires_in: expiresIn,
				scope: response.body.resource,
				token_type: response.body.token_type,
				refresh_in: refreshIn,
				correlation_id: response.body.correlation_id || response.body.correlationId,
				error: typeof response.body.error === "string" ? response.body.error : response.body.error?.code,
				error_description: response.body.message || (typeof response.body.error === "string" ? response.body.error_description : response.body.error?.message),
				error_codes: response.body.error_codes,
				timestamp: response.body.timestamp,
				trace_id: response.body.trace_id
			};
		}
		/**
		* Acquires an access token using the managed identity endpoint for the specified resource.
		* This is the primary method for token acquisition, handling the complete flow from
		* request creation through response processing and token caching.
		*
		* @param managedIdentityRequest - The managed identity request containing resource and optional parameters
		* @param managedIdentityId - The managed identity configuration (system or user-assigned)
		* @param fakeAuthority - Authority instance used for token caching (managed identity uses a placeholder authority)
		* @param refreshAccessToken - Whether this is a token refresh operation
		*
		* @returns Promise resolving to an authentication result containing the access token and metadata
		*
		* @throws {AuthError} When network requests fail or token validation fails
		* @throws {ClientAuthError} When network errors occur during the request
		*/
		async acquireTokenWithManagedIdentity(managedIdentityRequest, managedIdentityId, fakeAuthority, refreshAccessToken) {
			const networkRequest = this.createRequest(managedIdentityRequest.resource, managedIdentityId);
			if (managedIdentityRequest.revokedTokenSha256Hash) {
				this.logger.info(`[Managed Identity] The following claims are present in the request: ${managedIdentityRequest.claims}`);
				networkRequest.queryParameters[ManagedIdentityQueryParameters.SHA256_TOKEN_TO_REFRESH] = managedIdentityRequest.revokedTokenSha256Hash;
			}
			if (managedIdentityRequest.clientCapabilities?.length) {
				const clientCapabilities = managedIdentityRequest.clientCapabilities.toString();
				this.logger.info(`[Managed Identity] The following client capabilities are present in the request: ${clientCapabilities}`);
				networkRequest.queryParameters[ManagedIdentityQueryParameters.XMS_CC] = clientCapabilities;
			}
			const headers = networkRequest.headers;
			headers[HeaderNames.CONTENT_TYPE] = Constants$1.URL_FORM_CONTENT_TYPE;
			const networkRequestOptions = { headers };
			if (Object.keys(networkRequest.bodyParameters).length) networkRequestOptions.body = networkRequest.computeParametersBodyString();
			/**
			* Initializes the network client helper based on the retry policy configuration.
			* If internal retries are disabled, it uses the provided network client directly.
			* Otherwise, it wraps the network client with an HTTP client that supports retries.
			*/
			const networkClientHelper = this.disableInternalRetries ? this.networkClient : new HttpClientWithRetries(this.networkClient, networkRequest.retryPolicy, this.logger);
			const reqTimestamp = nowSeconds();
			let response;
			try {
				if (networkRequest.httpMethod === HttpMethod.POST) response = await networkClientHelper.sendPostRequestAsync(networkRequest.computeUri(), networkRequestOptions);
				else response = await networkClientHelper.sendGetRequestAsync(networkRequest.computeUri(), networkRequestOptions);
			} catch (error) {
				if (error instanceof AuthError) throw error;
				else throw createClientAuthError(networkError);
			}
			const responseHandler = new ResponseHandler(managedIdentityId.id, this.nodeStorage, this.cryptoProvider, this.logger, null, null);
			const serverTokenResponse = await this.getServerTokenResponseAsync(response, networkClientHelper, networkRequest, networkRequestOptions);
			responseHandler.validateTokenResponse(serverTokenResponse, refreshAccessToken);
			return responseHandler.handleServerTokenResponse(serverTokenResponse, fakeAuthority, reqTimestamp, managedIdentityRequest, ApiId.acquireTokenWithManagedIdentity);
		}
		/**
		* Determines the appropriate query parameter name for user-assigned managed identity
		* based on the identity type, API version, and endpoint characteristics.
		* Different Azure services and API versions use different parameter names for the same identity types.
		*
		* @param managedIdentityIdType - The type of user-assigned managed identity (client ID, object ID, or resource ID)
		* @param isImds - Whether the request is being made to the IMDS (Instance Metadata Service) endpoint
		* @param usesApi2017 - Whether the endpoint uses the 2017-09-01 API version (affects client ID parameter name)
		*
		* @returns The correct query parameter name for the specified identity type and endpoint
		*
		* @throws {ManagedIdentityError} When an invalid managed identity ID type is provided
		*/
		getManagedIdentityUserAssignedIdQueryParameterKey(managedIdentityIdType, isImds, usesApi2017) {
			switch (managedIdentityIdType) {
				case ManagedIdentityIdType.USER_ASSIGNED_CLIENT_ID:
					this.logger.info(`[Managed Identity] [API version ${usesApi2017 ? "2017+" : "2019+"}] Adding user assigned client id to the request.`);
					return usesApi2017 ? ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_CLIENT_ID_2017 : ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_CLIENT_ID;
				case ManagedIdentityIdType.USER_ASSIGNED_RESOURCE_ID:
					this.logger.info("[Managed Identity] Adding user assigned resource id to the request.");
					return isImds ? ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_RESOURCE_ID_IMDS : ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_RESOURCE_ID_NON_IMDS;
				case ManagedIdentityIdType.USER_ASSIGNED_OBJECT_ID:
					this.logger.info("[Managed Identity] Adding user assigned object id to the request.");
					return ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_OBJECT_ID;
				default: throw createManagedIdentityError(invalidManagedIdentityIdType);
			}
		}
	};
	/**
	* Validates and normalizes an environment variable containing a URL string.
	* This static utility method ensures that environment variables used for managed identity
	* endpoints contain properly formatted URLs and provides informative error messages when validation fails.
	*
	* @param envVariableStringName - The name of the environment variable being validated (for error reporting)
	* @param envVariable - The environment variable value containing the URL string
	* @param sourceName - The name of the managed identity source (for error reporting)
	* @param logger - Logger instance for diagnostic information
	*
	* @returns The validated and normalized URL string
	*
	* @throws {ManagedIdentityError} When the environment variable contains a malformed URL
	*/
	BaseManagedIdentitySource.getValidatedEnvVariableUrlString = (envVariableStringName, envVariable, sourceName, logger) => {
		try {
			return new UrlString(envVariable).urlString;
		} catch (error) {
			logger.info(`[Managed Identity] ${sourceName} managed identity is unavailable because the '${envVariableStringName}' environment variable is malformed.`);
			throw createManagedIdentityError(MsiEnvironmentVariableUrlMalformedErrorCodes[envVariableStringName]);
		}
	};
	var LinearRetryStrategy = class {
		/**
		* Calculates the number of milliseconds to sleep based on the `retry-after` HTTP header.
		*
		* @param retryHeader - The value of the `retry-after` HTTP header. This can be either a number of seconds
		*                      or an HTTP date string.
		* @returns The number of milliseconds to sleep before retrying the request. If the `retry-after` header is not
		*          present or cannot be parsed, returns 0.
		*/
		calculateDelay(retryHeader, minimumDelay) {
			if (!retryHeader) return minimumDelay;
			let millisToSleep = Math.round(parseFloat(retryHeader) * 1e3);
			if (isNaN(millisToSleep)) millisToSleep = new Date(retryHeader).valueOf() - (/* @__PURE__ */ new Date()).valueOf();
			return Math.max(minimumDelay, millisToSleep);
		}
	};
	const DEFAULT_MANAGED_IDENTITY_MAX_RETRIES = 3;
	const DEFAULT_MANAGED_IDENTITY_RETRY_DELAY_MS = 1e3;
	const DEFAULT_MANAGED_IDENTITY_HTTP_STATUS_CODES_TO_RETRY_ON = [
		msalCommon.HttpStatus.NOT_FOUND,
		msalCommon.HttpStatus.REQUEST_TIMEOUT,
		msalCommon.HttpStatus.TOO_MANY_REQUESTS,
		msalCommon.HttpStatus.SERVER_ERROR,
		msalCommon.HttpStatus.SERVICE_UNAVAILABLE,
		msalCommon.HttpStatus.GATEWAY_TIMEOUT
	];
	var DefaultManagedIdentityRetryPolicy = class DefaultManagedIdentityRetryPolicy {
		constructor() {
			this.linearRetryStrategy = new LinearRetryStrategy();
		}
		static get DEFAULT_MANAGED_IDENTITY_RETRY_DELAY_MS() {
			return DEFAULT_MANAGED_IDENTITY_RETRY_DELAY_MS;
		}
		async pauseForRetry(httpStatusCode, currentRetry, logger, retryAfterHeader) {
			if (DEFAULT_MANAGED_IDENTITY_HTTP_STATUS_CODES_TO_RETRY_ON.includes(httpStatusCode) && currentRetry < DEFAULT_MANAGED_IDENTITY_MAX_RETRIES) {
				const retryAfterDelay = this.linearRetryStrategy.calculateDelay(retryAfterHeader, DefaultManagedIdentityRetryPolicy.DEFAULT_MANAGED_IDENTITY_RETRY_DELAY_MS);
				logger.verbose(`Retrying request in ${retryAfterDelay}ms (retry attempt: ${currentRetry + 1})`);
				await new Promise((resolve) => {
					return setTimeout(resolve, retryAfterDelay);
				});
				return true;
			}
			return false;
		}
	};
	var ManagedIdentityRequestParameters = class {
		constructor(httpMethod, endpoint, retryPolicy) {
			this.httpMethod = httpMethod;
			this._baseEndpoint = endpoint;
			this.headers = {};
			this.bodyParameters = {};
			this.queryParameters = {};
			this.retryPolicy = retryPolicy || new DefaultManagedIdentityRetryPolicy();
		}
		computeUri() {
			const parameters = /* @__PURE__ */ new Map();
			if (this.queryParameters) addExtraQueryParameters(parameters, this.queryParameters);
			const queryParametersString = mapToQueryString(parameters);
			return UrlString.appendQueryString(this._baseEndpoint, queryParametersString);
		}
		computeParametersBodyString() {
			const parameters = /* @__PURE__ */ new Map();
			if (this.bodyParameters) addExtraQueryParameters(parameters, this.bodyParameters);
			return mapToQueryString(parameters);
		}
	};
	const APP_SERVICE_MSI_API_VERSION = "2019-08-01";
	/**
	* Azure App Service Managed Identity Source implementation.
	*
	* This class provides managed identity authentication for applications running in Azure App Service.
	* It uses the local metadata service endpoint available within App Service environments to obtain
	* access tokens without requiring explicit credentials.
	*
	* Original source of code: https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/identity/Azure.Identity/src/AppServiceManagedIdentitySource.cs
	*/
	var AppService = class AppService extends BaseManagedIdentitySource {
		/**
		* Creates a new instance of the AppService managed identity source.
		*
		* @param logger - Logger instance for diagnostic output
		* @param nodeStorage - Node.js storage implementation for caching
		* @param networkClient - Network client for making HTTP requests
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable internal retry logic
		* @param identityEndpoint - The App Service identity endpoint URL
		* @param identityHeader - The secret header value required for authentication
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint, identityHeader) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.identityEndpoint = identityEndpoint;
			this.identityHeader = identityHeader;
		}
		/**
		* Retrieves the required environment variables for App Service managed identity.
		*
		* App Service managed identity requires two environment variables:
		* - IDENTITY_ENDPOINT: The URL of the local metadata service
		* - IDENTITY_HEADER: A secret header value for authentication
		*
		* @returns An array containing [identityEndpoint, identityHeader] values from environment variables.
		*          Either value may be undefined if the environment variable is not set.
		*/
		static getEnvironmentVariables() {
			return [process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT], process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_HEADER]];
		}
		/**
		* Attempts to create an AppService managed identity source if the environment supports it.
		*
		* This method checks for the presence of required environment variables and validates
		* the identity endpoint URL. If the environment is not suitable for App Service managed
		* identity (missing environment variables or invalid endpoint), it returns null.
		*
		* @param logger - Logger instance for diagnostic output
		* @param nodeStorage - Node.js storage implementation for caching
		* @param networkClient - Network client for making HTTP requests
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable internal retry logic
		*
		* @returns A new AppService instance if the environment is suitable, null otherwise
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) {
			const [identityEndpoint, identityHeader] = AppService.getEnvironmentVariables();
			if (!identityEndpoint || !identityHeader) {
				logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.APP_SERVICE} managed identity is unavailable because one or both of the '${ManagedIdentityEnvironmentVariableNames.IDENTITY_HEADER}' and '${ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT}' environment variables are not defined.`);
				return null;
			}
			const validatedIdentityEndpoint = AppService.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT, identityEndpoint, ManagedIdentitySourceNames.APP_SERVICE, logger);
			logger.info(`[Managed Identity] Environment variables validation passed for ${ManagedIdentitySourceNames.APP_SERVICE} managed identity. Endpoint URI: ${validatedIdentityEndpoint}. Creating ${ManagedIdentitySourceNames.APP_SERVICE} managed identity.`);
			return new AppService(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint, identityHeader);
		}
		/**
		* Creates a managed identity token request for the App Service environment.
		*
		* This method constructs an HTTP GET request to the App Service identity endpoint
		* with the required headers, query parameters, and managed identity configuration.
		* The request includes the secret header for authentication and appropriate API version.
		*
		* @param resource - The target resource/scope for which to request an access token (e.g., "https://graph.microsoft.com/.default")
		* @param managedIdentityId - The managed identity configuration specifying whether to use system-assigned or user-assigned identity
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*/
		createRequest(resource, managedIdentityId) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.GET, this.identityEndpoint);
			request.headers[ManagedIdentityHeaders.APP_SERVICE_SECRET_HEADER_NAME] = this.identityHeader;
			request.queryParameters[ManagedIdentityQueryParameters.API_VERSION] = APP_SERVICE_MSI_API_VERSION;
			request.queryParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) request.queryParameters[this.getManagedIdentityUserAssignedIdQueryParameterKey(managedIdentityId.idType)] = managedIdentityId.id;
			return request;
		}
	};
	const ARC_API_VERSION = "2019-11-01";
	const DEFAULT_AZURE_ARC_IDENTITY_ENDPOINT = "http://127.0.0.1:40342/metadata/identity/oauth2/token";
	const HIMDS_EXECUTABLE_HELPER_STRING = "N/A: himds executable exists";
	const SUPPORTED_AZURE_ARC_PLATFORMS = {
		win32: `${process.env["ProgramData"]}\\AzureConnectedMachineAgent\\Tokens\\`,
		linux: "/var/opt/azcmagent/tokens/"
	};
	const AZURE_ARC_FILE_DETECTION = {
		win32: `${process.env["ProgramFiles"]}\\AzureConnectedMachineAgent\\himds.exe`,
		linux: "/opt/azcmagent/bin/himds"
	};
	/**
	* Azure Arc managed identity source implementation for acquiring tokens from Azure Arc-enabled servers.
	*
	* This class provides managed identity authentication for applications running on Azure Arc-enabled servers
	* by communicating with the local Hybrid Instance Metadata Service (HIMDS). It supports both environment
	* variable-based configuration and automatic detection through the HIMDS executable.
	*
	* Original source of code: https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/identity/Azure.Identity/src/AzureArcManagedIdentitySource.cs
	*/
	var AzureArc = class AzureArc extends BaseManagedIdentitySource {
		/**
		* Creates a new instance of the AzureArc managed identity source.
		*
		* @param logger - Logger instance for capturing telemetry and diagnostic information
		* @param nodeStorage - Storage implementation for caching tokens and metadata
		* @param networkClient - Network client for making HTTP requests to the identity endpoint
		* @param cryptoProvider - Cryptographic operations provider for token validation and encryption
		* @param disableInternalRetries - Flag to disable automatic retry logic for failed requests
		* @param identityEndpoint - The Azure Arc identity endpoint URL for token requests
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.identityEndpoint = identityEndpoint;
		}
		/**
		* Retrieves and validates Azure Arc environment variables for managed identity configuration.
		*
		* This method checks for IDENTITY_ENDPOINT and IMDS_ENDPOINT environment variables.
		* If either is missing, it attempts to detect the Azure Arc environment by checking for
		* the HIMDS executable at platform-specific paths. On successful detection, it returns
		* the default identity endpoint and a helper string indicating file-based detection.
		*
		* @returns An array containing [identityEndpoint, imdsEndpoint] where both values are
		*          strings if Azure Arc is available, or undefined if not available.
		*/
		static getEnvironmentVariables() {
			let identityEndpoint = process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT];
			let imdsEndpoint = process.env[ManagedIdentityEnvironmentVariableNames.IMDS_ENDPOINT];
			if (!identityEndpoint || !imdsEndpoint) {
				const fileDetectionPath = AZURE_ARC_FILE_DETECTION[process.platform];
				try {
					fs.accessSync(fileDetectionPath, fs.constants.F_OK | fs.constants.R_OK);
					identityEndpoint = DEFAULT_AZURE_ARC_IDENTITY_ENDPOINT;
					imdsEndpoint = HIMDS_EXECUTABLE_HELPER_STRING;
				} catch (err) {}
			}
			return [identityEndpoint, imdsEndpoint];
		}
		/**
		* Attempts to create an AzureArc managed identity source instance.
		*
		* Validates the Azure Arc environment by checking environment variables
		* and performing file-based detection. It ensures that only system-assigned managed identities
		* are supported for Azure Arc scenarios. The method performs comprehensive validation of
		* endpoint URLs and logs detailed information about the detection process.
		*
		* @param logger - Logger instance for capturing creation and validation steps
		* @param nodeStorage - Storage implementation for the managed identity source
		* @param networkClient - Network client for HTTP communication
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable automatic retry mechanisms
		* @param managedIdentityId - The managed identity configuration, must be system-assigned
		*
		* @returns AzureArc instance if the environment supports Azure Arc managed identity, null otherwise
		*
		* @throws {ManagedIdentityError} When a user-assigned managed identity is specified (not supported for Azure Arc)
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) {
			const [identityEndpoint, imdsEndpoint] = AzureArc.getEnvironmentVariables();
			if (!identityEndpoint || !imdsEndpoint) {
				logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.AZURE_ARC} managed identity is unavailable through environment variables because one or both of '${ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT}' and '${ManagedIdentityEnvironmentVariableNames.IMDS_ENDPOINT}' are not defined. ${ManagedIdentitySourceNames.AZURE_ARC} managed identity is also unavailable through file detection.`);
				return null;
			}
			if (imdsEndpoint === HIMDS_EXECUTABLE_HELPER_STRING) logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.AZURE_ARC} managed identity is available through file detection. Defaulting to known ${ManagedIdentitySourceNames.AZURE_ARC} endpoint: ${DEFAULT_AZURE_ARC_IDENTITY_ENDPOINT}. Creating ${ManagedIdentitySourceNames.AZURE_ARC} managed identity.`);
			else {
				const validatedIdentityEndpoint = AzureArc.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT, identityEndpoint, ManagedIdentitySourceNames.AZURE_ARC, logger);
				validatedIdentityEndpoint.endsWith("/") && validatedIdentityEndpoint.slice(0, -1);
				AzureArc.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.IMDS_ENDPOINT, imdsEndpoint, ManagedIdentitySourceNames.AZURE_ARC, logger);
				logger.info(`[Managed Identity] Environment variables validation passed for ${ManagedIdentitySourceNames.AZURE_ARC} managed identity. Endpoint URI: ${validatedIdentityEndpoint}. Creating ${ManagedIdentitySourceNames.AZURE_ARC} managed identity.`);
			}
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) throw createManagedIdentityError(unableToCreateAzureArc);
			return new AzureArc(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint);
		}
		/**
		* Creates a properly formatted HTTP request for acquiring tokens from the Azure Arc identity endpoint.
		*
		* This method constructs a GET request to the Azure Arc HIMDS endpoint with the required metadata header
		* and query parameters. The endpoint URL is normalized to use 127.0.0.1 instead of localhost for
		* consistency. Additional body parameters are calculated by the base class during token acquisition.
		*
		* @param resource - The target resource/scope for which to request an access token (e.g., "https://graph.microsoft.com/.default")
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*/
		createRequest(resource) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.GET, this.identityEndpoint.replace("localhost", "127.0.0.1"));
			request.headers[ManagedIdentityHeaders.METADATA_HEADER_NAME] = "true";
			request.queryParameters[ManagedIdentityQueryParameters.API_VERSION] = ARC_API_VERSION;
			request.queryParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			return request;
		}
		/**
		* Processes the server response and handles Azure Arc-specific authentication challenges.
		*
		* This method implements the Azure Arc authentication flow which may require reading a secret file
		* for authorization. When the initial request returns HTTP 401 Unauthorized, it extracts the file
		* path from the WWW-Authenticate header, validates the file location and size, reads the secret,
		* and retries the request with Basic authentication. The method includes comprehensive security
		* validations to prevent path traversal and ensure file integrity.
		*
		* @param originalResponse - The initial HTTP response from the identity endpoint
		* @param networkClient - Network client for making the retry request if needed
		* @param networkRequest - The original request parameters (modified with auth header for retry)
		* @param networkRequestOptions - Additional options for network requests
		*
		* @returns A promise that resolves to the server token response with access token and metadata
		*
		* @throws {ManagedIdentityError} When:
		*   - WWW-Authenticate header is missing or has unsupported format
		*   - Platform is not supported (not Windows or Linux)
		*   - Secret file has invalid extension (not .key)
		*   - Secret file path doesn't match expected platform path
		*   - Secret file cannot be read or is too large (>4096 bytes)
		* @throws {ClientAuthError} When network errors occur during retry request
		*/
		async getServerTokenResponseAsync(originalResponse, networkClient, networkRequest, networkRequestOptions) {
			let retryResponse;
			if (originalResponse.status === HttpStatus.UNAUTHORIZED) {
				const wwwAuthHeader = originalResponse.headers["www-authenticate"];
				if (!wwwAuthHeader) throw createManagedIdentityError(wwwAuthenticateHeaderMissing);
				if (!wwwAuthHeader.includes("Basic realm=")) throw createManagedIdentityError(wwwAuthenticateHeaderUnsupportedFormat);
				const secretFilePath = wwwAuthHeader.split("Basic realm=")[1];
				if (!SUPPORTED_AZURE_ARC_PLATFORMS.hasOwnProperty(process.platform)) throw createManagedIdentityError(platformNotSupported);
				const expectedSecretFilePath = SUPPORTED_AZURE_ARC_PLATFORMS[process.platform];
				const fileName = path.basename(secretFilePath);
				if (!fileName.endsWith(".key")) throw createManagedIdentityError(invalidFileExtension);
				if (expectedSecretFilePath + fileName !== secretFilePath) throw createManagedIdentityError(invalidFilePath);
				let secretFileSize;
				try {
					secretFileSize = await fs.statSync(secretFilePath).size;
				} catch (e) {
					throw createManagedIdentityError(unableToReadSecretFile);
				}
				if (secretFileSize > AZURE_ARC_SECRET_FILE_MAX_SIZE_BYTES) throw createManagedIdentityError(invalidSecret);
				let secret;
				try {
					secret = fs.readFileSync(secretFilePath, EncodingTypes.UTF8);
				} catch (e) {
					throw createManagedIdentityError(unableToReadSecretFile);
				}
				const authHeaderValue = `Basic ${secret}`;
				this.logger.info(`[Managed Identity] Adding authorization header to the request.`);
				networkRequest.headers[ManagedIdentityHeaders.AUTHORIZATION_HEADER_NAME] = authHeaderValue;
				try {
					retryResponse = await networkClient.sendGetRequestAsync(networkRequest.computeUri(), networkRequestOptions);
				} catch (error) {
					if (error instanceof AuthError) throw error;
					else throw createClientAuthError(networkError);
				}
			}
			return this.getServerTokenResponse(retryResponse || originalResponse);
		}
	};
	/**
	* Azure Cloud Shell managed identity source implementation.
	*
	* This class handles authentication for applications running in Azure Cloud Shell environment.
	* Cloud Shell provides a browser-accessible shell for managing Azure resources and includes
	* a pre-configured managed identity for authentication.
	*
	* Original source of code: https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/identity/Azure.Identity/src/CloudShellManagedIdentitySource.cs
	*/
	var CloudShell = class CloudShell extends BaseManagedIdentitySource {
		/**
		* Creates a new CloudShell managed identity source instance.
		*
		* @param logger - Logger instance for diagnostic logging
		* @param nodeStorage - Node.js storage implementation for caching
		* @param networkClient - HTTP client for making requests to the managed identity endpoint
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable automatic retry logic for failed requests
		* @param msiEndpoint - The MSI endpoint URL obtained from environment variables
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, msiEndpoint) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.msiEndpoint = msiEndpoint;
		}
		/**
		* Retrieves the required environment variables for Cloud Shell managed identity.
		*
		* Cloud Shell requires the MSI_ENDPOINT environment variable to be set, which
		* contains the URL of the managed identity service endpoint.
		*
		* @returns An array containing the MSI_ENDPOINT environment variable value (or undefined if not set)
		*/
		static getEnvironmentVariables() {
			return [process.env[ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT]];
		}
		/**
		* Attempts to create a CloudShell managed identity source instance.
		*
		* This method validates that the required environment variables are present and
		* creates a CloudShell instance if the environment is properly configured.
		* Cloud Shell only supports system-assigned managed identities.
		*
		* @param logger - Logger instance for diagnostic logging
		* @param nodeStorage - Node.js storage implementation for caching
		* @param networkClient - HTTP client for making requests
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable automatic retry logic
		* @param managedIdentityId - The managed identity configuration (must be system-assigned)
		*
		* @returns A CloudShell instance if the environment is valid, null otherwise
		*
		* @throws {ManagedIdentityError} When a user-assigned managed identity is requested,
		*         as Cloud Shell only supports system-assigned identities
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) {
			const [msiEndpoint] = CloudShell.getEnvironmentVariables();
			if (!msiEndpoint) {
				logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.CLOUD_SHELL} managed identity is unavailable because the '${ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT} environment variable is not defined.`);
				return null;
			}
			const validatedMsiEndpoint = CloudShell.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT, msiEndpoint, ManagedIdentitySourceNames.CLOUD_SHELL, logger);
			logger.info(`[Managed Identity] Environment variable validation passed for ${ManagedIdentitySourceNames.CLOUD_SHELL} managed identity. Endpoint URI: ${validatedMsiEndpoint}. Creating ${ManagedIdentitySourceNames.CLOUD_SHELL} managed identity.`);
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) throw createManagedIdentityError(unableToCreateCloudShell);
			return new CloudShell(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, msiEndpoint);
		}
		/**
		* Creates an HTTP request to acquire an access token from the Cloud Shell managed identity endpoint.
		*
		* This method constructs a POST request to the MSI endpoint with the required headers and
		* body parameters for Cloud Shell authentication. The request includes the target resource
		* for which the access token is being requested.
		*
		* @param resource - The target resource/scope for which to request an access token (e.g., "https://graph.microsoft.com/.default")
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*/
		createRequest(resource) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.POST, this.msiEndpoint);
			request.headers[ManagedIdentityHeaders.METADATA_HEADER_NAME] = "true";
			request.bodyParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			return request;
		}
	};
	var ExponentialRetryStrategy = class {
		constructor(minExponentialBackoff, maxExponentialBackoff, exponentialDeltaBackoff) {
			this.minExponentialBackoff = minExponentialBackoff;
			this.maxExponentialBackoff = maxExponentialBackoff;
			this.exponentialDeltaBackoff = exponentialDeltaBackoff;
		}
		/**
		* Calculates the exponential delay based on the current retry attempt.
		*
		* @param {number} currentRetry - The current retry attempt number.
		* @returns {number} - The calculated exponential delay in milliseconds.
		*
		* The delay is calculated using the formula:
		* - If `currentRetry` is 0, it returns the minimum backoff time.
		* - Otherwise, it calculates the delay as the minimum of:
		*   - `(2^(currentRetry - 1)) * deltaBackoff`
		*   - `maxBackoff`
		*
		* This ensures that the delay increases exponentially with each retry attempt,
		* but does not exceed the maximum backoff time.
		*/
		calculateDelay(currentRetry) {
			if (currentRetry === 0) return this.minExponentialBackoff;
			return Math.min(Math.pow(2, currentRetry - 1) * this.exponentialDeltaBackoff, this.maxExponentialBackoff);
		}
	};
	const HTTP_STATUS_400_CODES_FOR_EXPONENTIAL_STRATEGY = [
		msalCommon.HttpStatus.NOT_FOUND,
		msalCommon.HttpStatus.REQUEST_TIMEOUT,
		msalCommon.HttpStatus.GONE,
		msalCommon.HttpStatus.TOO_MANY_REQUESTS
	];
	const EXPONENTIAL_STRATEGY_NUM_RETRIES = 3;
	const LINEAR_STRATEGY_NUM_RETRIES = 7;
	const MIN_EXPONENTIAL_BACKOFF_MS = 1e3;
	const MAX_EXPONENTIAL_BACKOFF_MS = 4e3;
	const EXPONENTIAL_DELTA_BACKOFF_MS = 2e3;
	const HTTP_STATUS_GONE_RETRY_AFTER_MS = 10 * 1e3;
	var ImdsRetryPolicy = class ImdsRetryPolicy {
		constructor() {
			this.exponentialRetryStrategy = new ExponentialRetryStrategy(ImdsRetryPolicy.MIN_EXPONENTIAL_BACKOFF_MS, ImdsRetryPolicy.MAX_EXPONENTIAL_BACKOFF_MS, ImdsRetryPolicy.EXPONENTIAL_DELTA_BACKOFF_MS);
		}
		static get MIN_EXPONENTIAL_BACKOFF_MS() {
			return MIN_EXPONENTIAL_BACKOFF_MS;
		}
		static get MAX_EXPONENTIAL_BACKOFF_MS() {
			return MAX_EXPONENTIAL_BACKOFF_MS;
		}
		static get EXPONENTIAL_DELTA_BACKOFF_MS() {
			return EXPONENTIAL_DELTA_BACKOFF_MS;
		}
		static get HTTP_STATUS_GONE_RETRY_AFTER_MS() {
			return HTTP_STATUS_GONE_RETRY_AFTER_MS;
		}
		set isNewRequest(value) {
			this._isNewRequest = value;
		}
		/**
		* Pauses execution for a calculated delay before retrying a request.
		*
		* @param httpStatusCode - The HTTP status code of the response.
		* @param currentRetry - The current retry attempt number.
		* @param retryAfterHeader - The value of the "retry-after" header from the response.
		* @returns A promise that resolves to a boolean indicating whether a retry should be attempted.
		*/
		async pauseForRetry(httpStatusCode, currentRetry, logger) {
			if (this._isNewRequest) {
				this._isNewRequest = false;
				this.maxRetries = httpStatusCode === msalCommon.HttpStatus.GONE ? LINEAR_STRATEGY_NUM_RETRIES : EXPONENTIAL_STRATEGY_NUM_RETRIES;
			}
			/**
			* (status code is one of the retriable 400 status code
			* or
			* status code is >= 500 and <= 599)
			* and
			* current count of retries is less than the max number of retries
			*/
			if ((HTTP_STATUS_400_CODES_FOR_EXPONENTIAL_STRATEGY.includes(httpStatusCode) || httpStatusCode >= msalCommon.HttpStatus.SERVER_ERROR_RANGE_START && httpStatusCode <= msalCommon.HttpStatus.SERVER_ERROR_RANGE_END && currentRetry < this.maxRetries) && currentRetry < this.maxRetries) {
				const retryAfterDelay = httpStatusCode === msalCommon.HttpStatus.GONE ? ImdsRetryPolicy.HTTP_STATUS_GONE_RETRY_AFTER_MS : this.exponentialRetryStrategy.calculateDelay(currentRetry);
				logger.verbose(`Retrying request in ${retryAfterDelay}ms (retry attempt: ${currentRetry + 1})`);
				await new Promise((resolve) => {
					return setTimeout(resolve, retryAfterDelay);
				});
				return true;
			}
			return false;
		}
	};
	const IMDS_TOKEN_PATH = "/metadata/identity/oauth2/token";
	const DEFAULT_IMDS_ENDPOINT = `http://169.254.169.254${IMDS_TOKEN_PATH}`;
	const IMDS_API_VERSION = "2018-02-01";
	/**
	* Managed Identity source implementation for Azure Instance Metadata Service (IMDS).
	*
	* IMDS is available on Azure Virtual Machines and Virtual Machine Scale Sets and provides
	* a REST endpoint to obtain OAuth tokens for managed identities. This implementation
	* handles both system-assigned and user-assigned managed identities.
	*
	* Original source of code: https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/identity/Azure.Identity/src/ImdsManagedIdentitySource.cs
	*/
	var Imds = class Imds extends BaseManagedIdentitySource {
		/**
		* Constructs an Imds instance with the specified configuration.
		*
		* @param logger - Logger instance for recording debug information and errors
		* @param nodeStorage - NodeStorage instance used for token caching operations
		* @param networkClient - Network client implementation for making HTTP requests to IMDS
		* @param cryptoProvider - CryptoProvider for generating correlation IDs and other cryptographic operations
		* @param disableInternalRetries - When true, disables the built-in retry logic for IMDS requests
		* @param identityEndpoint - The complete IMDS endpoint URL including the token path
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.identityEndpoint = identityEndpoint;
		}
		/**
		* Creates an Imds instance with the appropriate endpoint configuration.
		*
		* This method checks for the presence of the AZURE_POD_IDENTITY_AUTHORITY_HOST environment
		* variable, which is used in Azure Kubernetes Service (AKS) environments with Azure AD
		* Pod Identity. If found, it uses that endpoint; otherwise, it falls back to the standard
		* IMDS endpoint (169.254.169.254).
		*
		* @param logger - Logger instance for recording endpoint discovery and validation
		* @param nodeStorage - NodeStorage instance for token caching
		* @param networkClient - Network client for HTTP requests
		* @param cryptoProvider - CryptoProvider for cryptographic operations
		* @param disableInternalRetries - Whether to disable built-in retry logic
		*
		* @returns A configured Imds instance ready to make token requests
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) {
			let validatedIdentityEndpoint;
			if (process.env[ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST]) {
				logger.info(`[Managed Identity] Environment variable ${ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST} for ${ManagedIdentitySourceNames.IMDS} returned endpoint: ${process.env[ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST]}`);
				validatedIdentityEndpoint = Imds.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST, `${process.env[ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST]}${IMDS_TOKEN_PATH}`, ManagedIdentitySourceNames.IMDS, logger);
			} else {
				logger.info(`[Managed Identity] Unable to find ${ManagedIdentityEnvironmentVariableNames.AZURE_POD_IDENTITY_AUTHORITY_HOST} environment variable for ${ManagedIdentitySourceNames.IMDS}, using the default endpoint.`);
				validatedIdentityEndpoint = DEFAULT_IMDS_ENDPOINT;
			}
			return new Imds(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, validatedIdentityEndpoint);
		}
		/**
		* Creates a properly configured HTTP request for acquiring an access token from IMDS.
		*
		* This method builds a complete request object with all necessary headers, query parameters,
		* and retry policies required by the Azure Instance Metadata Service.
		*
		* Key request components:
		* - HTTP GET method to the IMDS token endpoint
		* - Metadata header set to "true" (required by IMDS)
		* - API version parameter (currently "2018-02-01")
		* - Resource parameter specifying the target audience
		* - Identity-specific parameters for user-assigned managed identities
		* - IMDS-specific retry policy
		*
		* @param resource - The target resource/scope for which to request an access token (e.g., "https://graph.microsoft.com/.default")
		* @param managedIdentityId - The managed identity configuration specifying whether to use system-assigned or user-assigned identity
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*/
		createRequest(resource, managedIdentityId) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.GET, this.identityEndpoint);
			request.headers[ManagedIdentityHeaders.METADATA_HEADER_NAME] = "true";
			request.queryParameters[ManagedIdentityQueryParameters.API_VERSION] = IMDS_API_VERSION;
			request.queryParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) request.queryParameters[this.getManagedIdentityUserAssignedIdQueryParameterKey(managedIdentityId.idType, true)] = managedIdentityId.id;
			request.retryPolicy = new ImdsRetryPolicy();
			return request;
		}
	};
	const SERVICE_FABRIC_MSI_API_VERSION = "2019-07-01-preview";
	/**
	* Original source of code: https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/identity/Azure.Identity/src/ServiceFabricManagedIdentitySource.cs
	*/
	var ServiceFabric = class ServiceFabric extends BaseManagedIdentitySource {
		/**
		* Constructs a new ServiceFabric managed identity source for acquiring tokens from Azure Service Fabric clusters.
		*
		* Service Fabric managed identity allows applications running in Service Fabric clusters to authenticate
		* without storing credentials in code. This source handles token acquisition using the Service Fabric
		* Managed Identity Token Service (MITS).
		*
		* @param logger - Logger instance for logging authentication events and debugging information
		* @param nodeStorage - NodeStorage instance for caching tokens and other authentication artifacts
		* @param networkClient - Network client for making HTTP requests to the Service Fabric identity endpoint
		* @param cryptoProvider - Crypto provider for cryptographic operations like token validation
		* @param disableInternalRetries - Whether to disable internal retry logic for failed requests
		* @param identityEndpoint - The Service Fabric managed identity endpoint URL
		* @param identityHeader - The Service Fabric managed identity secret header value
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint, identityHeader) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.identityEndpoint = identityEndpoint;
			this.identityHeader = identityHeader;
		}
		/**
		* Retrieves the environment variables required for Service Fabric managed identity authentication.
		*
		* Service Fabric managed identity requires three specific environment variables to be set by the
		* Service Fabric runtime:
		* - IDENTITY_ENDPOINT: The endpoint URL for the Managed Identity Token Service (MITS)
		* - IDENTITY_HEADER: A secret value used for authentication with the MITS
		* - IDENTITY_SERVER_THUMBPRINT: The thumbprint of the MITS server certificate for secure communication
		*
		* @returns An array containing the identity endpoint, identity header, and identity server thumbprint values.
		*          Elements will be undefined if the corresponding environment variables are not set.
		*/
		static getEnvironmentVariables() {
			return [
				process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT],
				process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_HEADER],
				process.env[ManagedIdentityEnvironmentVariableNames.IDENTITY_SERVER_THUMBPRINT]
			];
		}
		/**
		* Attempts to create a ServiceFabric managed identity source if the runtime environment supports it.
		*
		* Checks for the presence of all required Service Fabric environment variables
		* and validates the endpoint URL format. It will only create a ServiceFabric instance if the application
		* is running in a properly configured Service Fabric cluster with managed identity enabled.
		*
		* Note: User-assigned managed identities must be configured at the cluster level, not at runtime.
		* This method will log a warning if a user-assigned identity is requested.
		*
		* @param logger - Logger instance for logging creation events and validation results
		* @param nodeStorage - NodeStorage instance for caching tokens and authentication artifacts
		* @param networkClient - Network client for making HTTP requests to the identity endpoint
		* @param cryptoProvider - Crypto provider for cryptographic operations
		* @param disableInternalRetries - Whether to disable internal retry logic for failed requests
		* @param managedIdentityId - Managed identity identifier specifying system-assigned or user-assigned identity
		*
		* @returns A ServiceFabric instance if all environment variables are valid and present, otherwise null
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) {
			const [identityEndpoint, identityHeader, identityServerThumbprint] = ServiceFabric.getEnvironmentVariables();
			if (!identityEndpoint || !identityHeader || !identityServerThumbprint) {
				logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.SERVICE_FABRIC} managed identity is unavailable because one or all of the '${ManagedIdentityEnvironmentVariableNames.IDENTITY_HEADER}', '${ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT}' or '${ManagedIdentityEnvironmentVariableNames.IDENTITY_SERVER_THUMBPRINT}' environment variables are not defined.`);
				return null;
			}
			const validatedIdentityEndpoint = ServiceFabric.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.IDENTITY_ENDPOINT, identityEndpoint, ManagedIdentitySourceNames.SERVICE_FABRIC, logger);
			logger.info(`[Managed Identity] Environment variables validation passed for ${ManagedIdentitySourceNames.SERVICE_FABRIC} managed identity. Endpoint URI: ${validatedIdentityEndpoint}. Creating ${ManagedIdentitySourceNames.SERVICE_FABRIC} managed identity.`);
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) logger.warning(`[Managed Identity] ${ManagedIdentitySourceNames.SERVICE_FABRIC} user assigned managed identity is configured in the cluster, not during runtime. See also: https://learn.microsoft.com/en-us/azure/service-fabric/configure-existing-cluster-enable-managed-identity-token-service.`);
			return new ServiceFabric(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, identityEndpoint, identityHeader);
		}
		/**
		* Creates HTTP request parameters for acquiring an access token from the Service Fabric Managed Identity Token Service (MITS).
		*
		* This method constructs a properly formatted HTTP GET request that includes:
		* - The secret header for authentication with MITS
		* - API version parameter for the Service Fabric MSI endpoint
		* - Resource parameter specifying the target Azure service
		* - Optional identity parameters for user-assigned managed identities
		*
		* The request follows the Service Fabric managed identity protocol and uses the 2019-07-01-preview API version.
		* For user-assigned identities, the appropriate query parameter (client_id, object_id, or resource_id) is added
		* based on the identity type.
		*
		* @param resource - The Azure resource URI for which the access token is requested (e.g., "https://vault.azure.net/")
		* @param managedIdentityId - The managed identity configuration specifying system-assigned or user-assigned identity details
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*/
		createRequest(resource, managedIdentityId) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.GET, this.identityEndpoint);
			request.headers[ManagedIdentityHeaders.ML_AND_SF_SECRET_HEADER_NAME] = this.identityHeader;
			request.queryParameters[ManagedIdentityQueryParameters.API_VERSION] = SERVICE_FABRIC_MSI_API_VERSION;
			request.queryParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			if (managedIdentityId.idType !== ManagedIdentityIdType.SYSTEM_ASSIGNED) request.queryParameters[this.getManagedIdentityUserAssignedIdQueryParameterKey(managedIdentityId.idType)] = managedIdentityId.id;
			return request;
		}
	};
	const MACHINE_LEARNING_MSI_API_VERSION = "2017-09-01";
	const MANAGED_IDENTITY_MACHINE_LEARNING_UNSUPPORTED_ID_TYPE_ERROR = `Only client id is supported for user-assigned managed identity in ${ManagedIdentitySourceNames.MACHINE_LEARNING}.`;
	/**
	* Machine Learning Managed Identity Source implementation for Azure Machine Learning environments.
	*
	* This class handles managed identity authentication specifically for Azure Machine Learning services.
	* It supports both system-assigned and user-assigned managed identities, using the MSI_ENDPOINT
	* and MSI_SECRET environment variables that are automatically provided in Azure ML environments.
	*/
	var MachineLearning = class MachineLearning extends BaseManagedIdentitySource {
		/**
		* Creates a new MachineLearning managed identity source instance.
		*
		* @param logger - Logger instance for diagnostic information
		* @param nodeStorage - Node storage implementation for caching
		* @param networkClient - Network client for making HTTP requests
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable automatic request retries
		* @param msiEndpoint - The MSI endpoint URL from environment variables
		* @param secret - The MSI secret from environment variables
		*/
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, msiEndpoint, secret) {
			super(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			this.msiEndpoint = msiEndpoint;
			this.secret = secret;
		}
		/**
		* Retrieves the required environment variables for Azure Machine Learning managed identity.
		*
		* This method checks for the presence of MSI_ENDPOINT and MSI_SECRET environment variables
		* that are automatically set by the Azure Machine Learning platform when managed identity
		* is enabled for the compute instance or cluster.
		*
		* @returns An array containing [msiEndpoint, secret] where either value may be undefined
		*          if the corresponding environment variable is not set
		*/
		static getEnvironmentVariables() {
			return [process.env[ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT], process.env[ManagedIdentityEnvironmentVariableNames.MSI_SECRET]];
		}
		/**
		* Attempts to create a MachineLearning managed identity source.
		*
		* This method validates the Azure Machine Learning environment by checking for the required
		* MSI_ENDPOINT and MSI_SECRET environment variables. If both are present and valid,
		* it creates and returns a MachineLearning instance. If either is missing or invalid,
		* it returns null, indicating that this managed identity source is not available
		* in the current environment.
		*
		* @param logger - Logger instance for diagnostic information
		* @param nodeStorage - Node storage implementation for caching
		* @param networkClient - Network client for making HTTP requests
		* @param cryptoProvider - Cryptographic operations provider
		* @param disableInternalRetries - Whether to disable automatic request retries
		*
		* @returns A new MachineLearning instance if the environment is valid, null otherwise
		*/
		static tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) {
			const [msiEndpoint, secret] = MachineLearning.getEnvironmentVariables();
			if (!msiEndpoint || !secret) {
				logger.info(`[Managed Identity] ${ManagedIdentitySourceNames.MACHINE_LEARNING} managed identity is unavailable because one or both of the '${ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT}' and '${ManagedIdentityEnvironmentVariableNames.MSI_SECRET}' environment variables are not defined.`);
				return null;
			}
			const validatedMsiEndpoint = MachineLearning.getValidatedEnvVariableUrlString(ManagedIdentityEnvironmentVariableNames.MSI_ENDPOINT, msiEndpoint, ManagedIdentitySourceNames.MACHINE_LEARNING, logger);
			logger.info(`[Managed Identity] Environment variables validation passed for ${ManagedIdentitySourceNames.MACHINE_LEARNING} managed identity. Endpoint URI: ${validatedMsiEndpoint}. Creating ${ManagedIdentitySourceNames.MACHINE_LEARNING} managed identity.`);
			return new MachineLearning(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, msiEndpoint, secret);
		}
		/**
		* Creates a managed identity token request for Azure Machine Learning environments.
		*
		* This method constructs the HTTP request parameters needed to acquire an access token
		* from the Azure Machine Learning managed identity endpoint. It handles both system-assigned
		* and user-assigned managed identities with specific logic for each type:
		*
		* - System-assigned: Uses the DEFAULT_IDENTITY_CLIENT_ID environment variable
		* - User-assigned: Only supports client ID-based identification (not object ID or resource ID)
		*
		* The request uses the 2017-09-01 API version and includes the required secret header
		* for authentication with the MSI endpoint.
		*
		* @param resource - The target resource/scope for which to request an access token (e.g., "https://graph.microsoft.com/.default")
		* @param managedIdentityId - The managed identity configuration specifying whether to use system-assigned or user-assigned identity
		*
		* @returns A configured ManagedIdentityRequestParameters object ready for network execution
		*
		* @throws Error if an unsupported managed identity ID type is specified (only client ID is supported for user-assigned)
		*/
		createRequest(resource, managedIdentityId) {
			const request = new ManagedIdentityRequestParameters(HttpMethod.GET, this.msiEndpoint);
			request.headers[ManagedIdentityHeaders.METADATA_HEADER_NAME] = "true";
			request.headers[ManagedIdentityHeaders.ML_AND_SF_SECRET_HEADER_NAME] = this.secret;
			request.queryParameters[ManagedIdentityQueryParameters.API_VERSION] = MACHINE_LEARNING_MSI_API_VERSION;
			request.queryParameters[ManagedIdentityQueryParameters.RESOURCE] = resource;
			if (managedIdentityId.idType === ManagedIdentityIdType.SYSTEM_ASSIGNED) request.queryParameters[ManagedIdentityUserAssignedIdQueryParameterNames.MANAGED_IDENTITY_CLIENT_ID_2017] = process.env[ManagedIdentityEnvironmentVariableNames.DEFAULT_IDENTITY_CLIENT_ID];
			else if (managedIdentityId.idType === ManagedIdentityIdType.USER_ASSIGNED_CLIENT_ID) request.queryParameters[this.getManagedIdentityUserAssignedIdQueryParameterKey(managedIdentityId.idType, false, true)] = managedIdentityId.id;
			else throw new Error(MANAGED_IDENTITY_MACHINE_LEARNING_UNSUPPORTED_ID_TYPE_ERROR);
			return request;
		}
	};
	var ManagedIdentityClient = class ManagedIdentityClient {
		constructor(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) {
			this.logger = logger;
			this.nodeStorage = nodeStorage;
			this.networkClient = networkClient;
			this.cryptoProvider = cryptoProvider;
			this.disableInternalRetries = disableInternalRetries;
		}
		async sendManagedIdentityTokenRequest(managedIdentityRequest, managedIdentityId, fakeAuthority, refreshAccessToken) {
			if (!ManagedIdentityClient.identitySource) ManagedIdentityClient.identitySource = this.selectManagedIdentitySource(this.logger, this.nodeStorage, this.networkClient, this.cryptoProvider, this.disableInternalRetries, managedIdentityId);
			return ManagedIdentityClient.identitySource.acquireTokenWithManagedIdentity(managedIdentityRequest, managedIdentityId, fakeAuthority, refreshAccessToken);
		}
		allEnvironmentVariablesAreDefined(environmentVariables) {
			return Object.values(environmentVariables).every((environmentVariable) => {
				return environmentVariable !== void 0;
			});
		}
		/**
		* Determine the Managed Identity Source based on available environment variables. This API is consumed by ManagedIdentityApplication's getManagedIdentitySource.
		* @returns ManagedIdentitySourceNames - The Managed Identity source's name
		*/
		getManagedIdentitySource() {
			ManagedIdentityClient.sourceName = this.allEnvironmentVariablesAreDefined(ServiceFabric.getEnvironmentVariables()) ? ManagedIdentitySourceNames.SERVICE_FABRIC : this.allEnvironmentVariablesAreDefined(AppService.getEnvironmentVariables()) ? ManagedIdentitySourceNames.APP_SERVICE : this.allEnvironmentVariablesAreDefined(MachineLearning.getEnvironmentVariables()) ? ManagedIdentitySourceNames.MACHINE_LEARNING : this.allEnvironmentVariablesAreDefined(CloudShell.getEnvironmentVariables()) ? ManagedIdentitySourceNames.CLOUD_SHELL : this.allEnvironmentVariablesAreDefined(AzureArc.getEnvironmentVariables()) ? ManagedIdentitySourceNames.AZURE_ARC : ManagedIdentitySourceNames.DEFAULT_TO_IMDS;
			return ManagedIdentityClient.sourceName;
		}
		/**
		* Tries to create a managed identity source for all sources
		* @returns the managed identity Source
		*/
		selectManagedIdentitySource(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) {
			const source = ServiceFabric.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) || AppService.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) || MachineLearning.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries) || CloudShell.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) || AzureArc.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries, managedIdentityId) || Imds.tryCreate(logger, nodeStorage, networkClient, cryptoProvider, disableInternalRetries);
			if (!source) throw createManagedIdentityError(unableToCreateSource);
			return source;
		}
	};
	const SOURCES_THAT_SUPPORT_TOKEN_REVOCATION = [ManagedIdentitySourceNames.SERVICE_FABRIC];
	/**
	* Class to initialize a managed identity and identify the service
	* @public
	*/
	var ManagedIdentityApplication = class ManagedIdentityApplication {
		constructor(configuration) {
			this.config = buildManagedIdentityConfiguration(configuration || {});
			this.logger = new Logger(this.config.system.loggerOptions, name, version);
			const fakeStatusAuthorityOptions = { canonicalAuthority: Constants$1.DEFAULT_AUTHORITY };
			if (!ManagedIdentityApplication.nodeStorage) ManagedIdentityApplication.nodeStorage = new NodeStorage(this.logger, this.config.managedIdentityId.id, DEFAULT_CRYPTO_IMPLEMENTATION, fakeStatusAuthorityOptions);
			this.networkClient = this.config.system.networkClient;
			this.cryptoProvider = new CryptoProvider();
			const fakeAuthorityOptions = {
				protocolMode: ProtocolMode.AAD,
				knownAuthorities: [DEFAULT_AUTHORITY_FOR_MANAGED_IDENTITY],
				cloudDiscoveryMetadata: "",
				authorityMetadata: ""
			};
			this.fakeAuthority = new Authority(DEFAULT_AUTHORITY_FOR_MANAGED_IDENTITY, this.networkClient, ManagedIdentityApplication.nodeStorage, fakeAuthorityOptions, this.logger, this.cryptoProvider.createNewGuid(), void 0, true);
			this.fakeClientCredentialClient = new ClientCredentialClient({ authOptions: {
				clientId: this.config.managedIdentityId.id,
				authority: this.fakeAuthority
			} });
			this.managedIdentityClient = new ManagedIdentityClient(this.logger, ManagedIdentityApplication.nodeStorage, this.networkClient, this.cryptoProvider, this.config.disableInternalRetries);
			this.hashUtils = new HashUtils();
		}
		/**
		* Acquire an access token from the cache or the managed identity
		* @param managedIdentityRequest - the ManagedIdentityRequestParams object passed in by the developer
		* @returns the access token
		*/
		async acquireToken(managedIdentityRequestParams) {
			if (!managedIdentityRequestParams.resource) throw createClientConfigurationError(urlEmptyError);
			const managedIdentityRequest = {
				forceRefresh: managedIdentityRequestParams.forceRefresh,
				resource: managedIdentityRequestParams.resource.replace("/.default", ""),
				scopes: [managedIdentityRequestParams.resource.replace("/.default", "")],
				authority: this.fakeAuthority.canonicalAuthority,
				correlationId: this.cryptoProvider.createNewGuid(),
				claims: managedIdentityRequestParams.claims,
				clientCapabilities: this.config.clientCapabilities
			};
			if (managedIdentityRequest.forceRefresh) return this.acquireTokenFromManagedIdentity(managedIdentityRequest, this.config.managedIdentityId, this.fakeAuthority);
			const [cachedAuthenticationResult, lastCacheOutcome] = await this.fakeClientCredentialClient.getCachedAuthenticationResult(managedIdentityRequest, this.config, this.cryptoProvider, this.fakeAuthority, ManagedIdentityApplication.nodeStorage);
			if (managedIdentityRequest.claims) {
				const sourceName = this.managedIdentityClient.getManagedIdentitySource();
				if (cachedAuthenticationResult && SOURCES_THAT_SUPPORT_TOKEN_REVOCATION.includes(sourceName)) managedIdentityRequest.revokedTokenSha256Hash = this.hashUtils.sha256(cachedAuthenticationResult.accessToken).toString(EncodingTypes.HEX);
				return this.acquireTokenFromManagedIdentity(managedIdentityRequest, this.config.managedIdentityId, this.fakeAuthority);
			}
			if (cachedAuthenticationResult) {
				if (lastCacheOutcome === CacheOutcome.PROACTIVELY_REFRESHED) {
					this.logger.info("ClientCredentialClient:getCachedAuthenticationResult - Cached access token's refreshOn property has been exceeded'. It's not expired, but must be refreshed.");
					await this.acquireTokenFromManagedIdentity(managedIdentityRequest, this.config.managedIdentityId, this.fakeAuthority, true);
				}
				return cachedAuthenticationResult;
			} else return this.acquireTokenFromManagedIdentity(managedIdentityRequest, this.config.managedIdentityId, this.fakeAuthority);
		}
		/**
		* Acquires a token from a managed identity endpoint.
		*
		* @param managedIdentityRequest - The request object containing parameters for the managed identity token request.
		* @param managedIdentityId - The identifier for the managed identity (e.g., client ID or resource ID).
		* @param fakeAuthority - A placeholder authority used for the token request.
		* @param refreshAccessToken - Optional flag indicating whether to force a refresh of the access token.
		* @returns A promise that resolves to an AuthenticationResult containing the acquired token and related information.
		*/
		async acquireTokenFromManagedIdentity(managedIdentityRequest, managedIdentityId, fakeAuthority, refreshAccessToken) {
			return this.managedIdentityClient.sendManagedIdentityTokenRequest(managedIdentityRequest, managedIdentityId, fakeAuthority, refreshAccessToken);
		}
		/**
		* Determine the Managed Identity Source based on available environment variables. This API is consumed by Azure Identity SDK.
		* @returns ManagedIdentitySourceNames - The Managed Identity source's name
		*/
		getManagedIdentitySource() {
			return ManagedIdentityClient.sourceName || this.managedIdentityClient.getManagedIdentitySource();
		}
	};
	/**
	* Cache plugin that serializes data to the cache and deserializes data from the cache
	* @public
	*/
	var DistributedCachePlugin = class {
		constructor(client, partitionManager) {
			this.client = client;
			this.partitionManager = partitionManager;
		}
		/**
		* Deserializes the cache before accessing it
		* @param cacheContext - TokenCacheContext
		*/
		async beforeCacheAccess(cacheContext) {
			const partitionKey = await this.partitionManager.getKey();
			const cacheData = await this.client.get(partitionKey);
			cacheContext.tokenCache.deserialize(cacheData);
		}
		/**
		* Serializes the cache after accessing it
		* @param cacheContext - TokenCacheContext
		*/
		async afterCacheAccess(cacheContext) {
			if (cacheContext.cacheHasChanged) {
				const kvStore = cacheContext.tokenCache.getKVStore();
				const accountEntities = Object.values(kvStore).filter((value) => AccountEntity.isAccountEntity(value));
				let partitionKey;
				if (accountEntities.length > 0) {
					const accountEntity = accountEntities[0];
					partitionKey = await this.partitionManager.extractKey(accountEntity);
				} else partitionKey = await this.partitionManager.getKey();
				await this.client.set(partitionKey, cacheContext.tokenCache.serialize());
			}
		}
	};
	exports.AuthError = AuthError;
	exports.AuthErrorCodes = AuthErrorCodes;
	exports.AuthErrorMessage = AuthErrorMessage;
	exports.AzureCloudInstance = AzureCloudInstance;
	exports.ClientApplication = ClientApplication;
	exports.ClientAssertion = ClientAssertion;
	exports.ClientAuthError = ClientAuthError;
	exports.ClientAuthErrorCodes = ClientAuthErrorCodes;
	exports.ClientAuthErrorMessage = ClientAuthErrorMessage;
	exports.ClientConfigurationError = ClientConfigurationError;
	exports.ClientConfigurationErrorCodes = ClientConfigurationErrorCodes;
	exports.ClientConfigurationErrorMessage = ClientConfigurationErrorMessage;
	exports.ClientCredentialClient = ClientCredentialClient;
	exports.ConfidentialClientApplication = ConfidentialClientApplication;
	exports.CryptoProvider = CryptoProvider;
	exports.DeviceCodeClient = DeviceCodeClient;
	exports.DistributedCachePlugin = DistributedCachePlugin;
	exports.InteractionRequiredAuthError = InteractionRequiredAuthError;
	exports.InteractionRequiredAuthErrorCodes = InteractionRequiredAuthErrorCodes;
	exports.InteractionRequiredAuthErrorMessage = InteractionRequiredAuthErrorMessage;
	exports.Logger = Logger;
	exports.ManagedIdentityApplication = ManagedIdentityApplication;
	exports.ManagedIdentitySourceNames = ManagedIdentitySourceNames;
	exports.OnBehalfOfClient = OnBehalfOfClient;
	exports.PromptValue = PromptValue;
	exports.ProtocolMode = ProtocolMode;
	exports.PublicClientApplication = PublicClientApplication;
	exports.ResponseMode = ResponseMode;
	exports.ServerError = ServerError;
	exports.TokenCache = TokenCache;
	exports.TokenCacheContext = TokenCacheContext;
	exports.UsernamePasswordClient = UsernamePasswordClient;
	exports.internals = internals;
	exports.version = version;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/token-manager.js
var require_token_manager = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TokenManager = void 0;
	const msal_node_1 = require_msal_node();
	const teams_api_1 = require_dist$2();
	const teams_common_1 = require_dist$3();
	const DEFAULT_TENANT_FOR_GRAPH_TOKEN = "common";
	const MSAL_LOG_LEVEL_TO_LOG_LEVEL = {
		[msal_node_1.LogLevel.Error]: "error",
		[msal_node_1.LogLevel.Warning]: "warn",
		[msal_node_1.LogLevel.Info]: "info",
		[msal_node_1.LogLevel.Verbose]: "debug",
		[msal_node_1.LogLevel.Trace]: "trace"
	};
	const LOG_LEVEL_TO_MSAL_LOG_LEVEL = {
		"error": msal_node_1.LogLevel.Error,
		"warn": msal_node_1.LogLevel.Warning,
		"info": msal_node_1.LogLevel.Info,
		"debug": msal_node_1.LogLevel.Verbose,
		"trace": msal_node_1.LogLevel.Trace
	};
	function isClientCredentials(credentials) {
		return "clientSecret" in credentials;
	}
	function isTokenCredentials(credentials) {
		return "token" in credentials;
	}
	function isFederatedIdentityCredentials(credentials) {
		return "managedIdentityType" in credentials;
	}
	var TokenManager = class {
		credentials;
		logger;
		_msalLogger;
		cloud;
		confidentialClientsByTenantId = {};
		managedIdentityClient = null;
		constructor(options, logger) {
			this.logger = logger.child("TokenManager") ?? new teams_common_1.ConsoleLogger("TokenManager");
			this._msalLogger = this.logger.child("azure/msal-node", { pattern: "-azure/msal-node" });
			this.cloud = options.cloud ?? teams_api_1.PUBLIC;
			this.credentials = this.initializeCredentials(options);
		}
		async getBotToken() {
			return await this.getToken(this.cloud.botScope, this.resolveTenantId(void 0, this.cloud.loginTenant));
		}
		async getGraphToken(tenantId) {
			return await this.getToken(this.cloud.graphScope, this.resolveTenantId(tenantId, DEFAULT_TENANT_FOR_GRAPH_TOKEN));
		}
		initializeCredentials(options) {
			const clientId = options.clientId ?? process.env.CLIENT_ID;
			const tenantId = options.tenantId ?? process.env.TENANT_ID;
			const clientSecret = options.clientSecret ?? process.env.CLIENT_SECRET;
			const token = options.token;
			const managedIdentityClientId = options.managedIdentityClientId ?? process.env.MANAGED_IDENTITY_CLIENT_ID;
			if (clientId && clientSecret) {
				this.logger.debug("Using Client Credentials auth");
				return {
					clientId,
					clientSecret,
					tenantId
				};
			} else if (clientId && token) {
				this.logger.debug("Using custom token factory auth");
				return {
					clientId,
					tenantId,
					token
				};
			} else if (clientId && !clientSecret) if (managedIdentityClientId == null || managedIdentityClientId.toLowerCase() === clientId.toLowerCase()) {
				this.logger.debug("Using user managed identity auth");
				return {
					clientId,
					tenantId
				};
			} else {
				const identityType = managedIdentityClientId === "system" ? "system" : "user";
				this.logger.debug(`Using Federated Identity Credentials auth (${identityType})`);
				return {
					clientId,
					tenantId,
					managedIdentityClientId,
					managedIdentityType: identityType
				};
			}
		}
		async getToken(scope, tenantId) {
			if (!this.credentials) return null;
			if (isClientCredentials(this.credentials)) return this.getTokenWithClientCredentials(this.credentials, scope, tenantId);
			else if (isTokenCredentials(this.credentials)) return this.getTokenWithTokenProvider(this.credentials, scope, tenantId);
			else if (isFederatedIdentityCredentials(this.credentials)) return this.getTokenWithFederatedCredentials(this.credentials, scope, tenantId);
			else return this.getTokenWithManagedIdentity(this.credentials, scope);
		}
		async getTokenWithClientCredentials(credentials, scope, tenantId) {
			const result = await this.getConfidentialClient(credentials, tenantId).acquireTokenByClientCredential({ scopes: [scope] });
			return this.handleTokenResponse(result);
		}
		async getTokenWithTokenProvider(credentials, scope, tenantId) {
			const token = await credentials.token(scope, tenantId);
			return new teams_api_1.JsonWebToken(token);
		}
		async getTokenWithManagedIdentity(credentials, scope) {
			const managedIdentityClient = this.getManagedIdentityClient(credentials);
			const resource = scope.replace("/.default", "");
			const result = await managedIdentityClient.acquireToken({ resource });
			return this.handleTokenResponse(result);
		}
		async getTokenWithFederatedCredentials(credentials, scope, tenantId) {
			const managedIdentityTokenRes = await this.getManagedIdentityClient(credentials).acquireToken({ resource: "api://AzureADTokenExchange" });
			const result = await new msal_node_1.ConfidentialClientApplication({
				auth: {
					clientId: credentials.clientId,
					clientAssertion: managedIdentityTokenRes.accessToken,
					authority: `${this.cloud.loginEndpoint}/${tenantId}`
				},
				system: { loggerOptions: this.buildLoggerOptions() }
			}).acquireTokenByClientCredential({ scopes: [scope] });
			return this.handleTokenResponse(result);
		}
		resolveTenantId(tenantId, defaultTenantId) {
			return tenantId || this.credentials?.tenantId || defaultTenantId;
		}
		getConfidentialClient(credentials, tenantId) {
			const cachedClient = this.confidentialClientsByTenantId[tenantId];
			if (cachedClient) return cachedClient;
			const client = new msal_node_1.ConfidentialClientApplication({
				auth: {
					clientId: credentials.clientId,
					clientSecret: credentials.clientSecret,
					authority: `${this.cloud.loginEndpoint}/${tenantId}`
				},
				system: { loggerOptions: this.buildLoggerOptions() }
			});
			this.confidentialClientsByTenantId[tenantId] = client;
			return client;
		}
		getManagedIdentityClient(credentials) {
			if (this.managedIdentityClient) return this.managedIdentityClient;
			if (isFederatedIdentityCredentials(credentials)) if (credentials.managedIdentityType === "user") this.managedIdentityClient = new msal_node_1.ManagedIdentityApplication({
				managedIdentityIdParams: { userAssignedClientId: credentials.managedIdentityClientId },
				system: { loggerOptions: this.buildLoggerOptions() }
			});
			else this.managedIdentityClient = new msal_node_1.ManagedIdentityApplication({
				managedIdentityIdParams: void 0,
				system: { loggerOptions: this.buildLoggerOptions() }
			});
			else this.managedIdentityClient = new msal_node_1.ManagedIdentityApplication({
				managedIdentityIdParams: { userAssignedClientId: credentials.clientId },
				system: { loggerOptions: this.buildLoggerOptions() }
			});
			return this.managedIdentityClient;
		}
		handleTokenResponse(result) {
			if (!result) throw new Error("Failed to get token");
			return new teams_api_1.JsonWebToken(result.accessToken);
		}
		buildLoggerOptions() {
			return {
				logLevel: this.logger.loggerOptions?.level != null ? LOG_LEVEL_TO_MSAL_LOG_LEVEL[this.logger.loggerOptions.level] : void 0,
				loggerCallback: (level, message) => {
					if (message.endsWith("Warning - No client info in response")) return;
					this._msalLogger.log(MSAL_LOG_LEVEL_TO_LOG_LEVEL[level], message);
				},
				piiLoggingEnabled: false
			};
		}
	};
	exports.TokenManager = TokenManager;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/app.js
var require_app = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.App = void 0;
	const axios_1 = require_axios();
	const teams_api_1 = require_dist$2();
	const teams_common_1 = require_dist$3();
	const package_json_1 = __importDefault(require_package());
	const activity_sender_1 = require_activity_sender();
	const api_1 = require_api();
	const app_embed_1 = require_app_embed();
	const app_events_1 = require_app_events();
	const app_oauth_1 = require_app_oauth();
	const app_plugins_1 = require_app_plugins();
	const app_process_1 = require_app_process();
	const app_routing_1 = require_app_routing();
	const container_1 = require_container();
	const http_1 = require_http$1();
	const http_server_1 = require_http_server();
	const middleware = __importStar(require_middleware());
	const oauth_1 = require_oauth();
	const router_1 = require_router();
	const token_manager_1 = require_token_manager();
	const thread_1 = require_thread();
	/**
	* The orchestrator for receiving/sending activities
	*/
	var App = class {
		options;
		api;
		cloud;
		graph;
		log;
		server;
		http;
		client;
		storage;
		entraTokenValidator;
		tokenManager;
		/**
		* Graph API base URL derived from the configured cloud's `graphScope`.
		* Undefined when the scope isn't a URL — `GraphClient` then uses its public-cloud default.
		* Shared across every `GraphClient` the app constructs (`app.graph`, `ctx.appGraph`, `ctx.userGraph`)
		* so sovereign customers get consistent routing.
		*/
		graphBaseUrl;
		/**
		* the apps credentials
		*/
		get credentials() {
			return this.tokenManager.credentials;
		}
		/**
		* the apps id
		*/
		get id() {
			return this.credentials?.clientId;
		}
		/**
		* the apps name
		* @deprecated Name will be removed in the near future. Please remove dependencies from it.
		*/
		get name() {
			return this._manifest.name?.full;
		}
		get oauth() {
			return {
				...oauth_1.DEFAULT_OAUTH_SETTINGS,
				...this.options.oauth
			};
		}
		/**
		* the apps manifest
		*/
		get manifest() {
			return {
				id: this.id,
				name: {
					short: this._manifest.name?.short || "??",
					full: this._manifest.name?.full || "??"
				},
				bots: [{
					botId: this.id || "??",
					scopes: ["personal"]
				}],
				webApplicationInfo: {
					id: this.credentials?.clientId || "??",
					resource: `api://\${{BOT_DOMAIN}}/${this.credentials?.clientId || "??"}`,
					...this._manifest.webApplicationInfo
				},
				...this._manifest
			};
		}
		_manifest;
		container = new container_1.Container();
		plugins = [];
		router = new router_1.Router();
		tenantTokens = new teams_common_1.LocalStorage({}, { max: 2e4 });
		events = new teams_common_1.EventEmitter();
		isInitialized = false;
		port;
		activitySender;
		_userAgent = `teams.ts[apps]/${package_json_1.default.version}`;
		constructor(options = {}) {
			this.options = options;
			this.log = this.options.logger || new teams_common_1.ConsoleLogger("@teams/app");
			this.storage = this.options.storage || new teams_common_1.LocalStorage();
			this._manifest = this.options.manifest || {};
			const cloudEnvName = typeof process !== "undefined" ? process.env.CLOUD : void 0;
			this.cloud = this.options.cloud ?? (cloudEnvName ? (0, teams_api_1.cloudFromName)(cloudEnvName) : teams_api_1.PUBLIC);
			if (!options.client) this.client = new teams_common_1.Client({ headers: { "User-Agent": this._userAgent } });
			else if (typeof options.client === "function") this.client = options.client().clone({ headers: { "User-Agent": this._userAgent } });
			else if ("request" in options.client) this.client = options.client.clone({ headers: { "User-Agent": this._userAgent } });
			else this.client = new teams_common_1.Client(options.client).clone({ headers: { "User-Agent": this._userAgent } });
			const serviceUrl = (this.options.serviceUrl ?? process.env.SERVICE_URL ?? "https://smba.trafficmanager.net/teams").replace(/\/+$/, "");
			this.api = new api_1.ApiClient(serviceUrl, this.client.clone({ token: () => this.getBotToken() }), this.options.apiClientSettings, this.cloud);
			const graphUrlMatch = /^(https?:\/\/[^/]+)/i.exec((this.cloud.graphScope ?? "").trim());
			this.graphBaseUrl = graphUrlMatch?.[1];
			if (!this.graphBaseUrl && this.cloud.graphScope) this.log.warn(`graphScope "${this.cloud.graphScope}" is not a URL; Graph calls will route to the public cloud. Set graphScope to an "https://<host>/.default" value to route to the correct Graph endpoint.`);
			this.graph = new api_1.GraphClient(this.client.clone({ token: () => this.getAppGraphToken() }), { baseUrlRoot: this.graphBaseUrl });
			this.tokenManager = new token_manager_1.TokenManager({
				clientId: this.options.clientId,
				clientSecret: this.options.clientSecret,
				tenantId: this.options.tenantId,
				token: this.options.token,
				managedIdentityClientId: this.options.managedIdentityClientId,
				cloud: this.cloud
			}, this.log);
			this.activitySender = new activity_sender_1.ActivitySender(this.client.clone({ token: () => this.getBotToken() }), this.log);
			if (this.credentials?.clientId) this.entraTokenValidator = middleware.createEntraTokenValidator(this.credentials.tenantId || "common", this.credentials.clientId, {
				applicationIdUri: this.options.applicationIdUri,
				loginEndpoint: this.cloud.loginEndpoint,
				logger: this.log
			});
			const plugins = this.options.plugins || [];
			const httpPlugin = plugins.find((p) => {
				return (0, app_plugins_1.getMetadata)(p).name === "http";
			});
			if (this.options.httpServerAdapter && httpPlugin) throw new Error("Cannot provide both httpServerAdapter option and HttpPlugin in plugins array. Use either:\n  - new App({ httpServerAdapter: new ExpressAdapter() }) (recommended)\n  - new App({ plugins: [new HttpPlugin()] }) (deprecated)");
			let server;
			if (httpPlugin) {
				this.log.warn("[DEPRECATED] HttpPlugin in plugins array will be deprecated. Use httpServerAdapter option instead:\n  new App({ httpServerAdapter: new ExpressAdapter() })");
				this.http = httpPlugin;
				server = httpPlugin.asServer?.();
				if (!server) throw new Error("HttpPlugin.asServer() returned undefined");
			} else server = new http_server_1.HttpServer(this.options.httpServerAdapter ?? new http_1.ExpressAdapter(void 0, {
				logger: this.log,
				onError: (err) => this.onError({ error: err })
			}), {
				skipAuth: this.options.skipAuth,
				logger: this.log,
				messagingEndpoint: this.options.messagingEndpoint ?? "/api/messages"
			});
			this.server = server;
			server.onRequest = (event) => this.onActivity(event);
			this.container.register("id", { useValue: this.id });
			this.container.register("name", { useValue: this.name });
			this.container.register("manifest", { useValue: this.manifest });
			this.container.register("credentials", { useValue: this.credentials });
			this.container.register("botToken", { useValue: () => this.getBotToken() });
			this.container.register("ILogger", { useValue: this.log });
			this.container.register("IStorage", { useValue: this.storage });
			this.container.register(this.client.constructor.name, { useFactory: () => this.client });
			this.container.register("IHttpServer", { useValue: server });
			for (const plugin of plugins) this.plugin(plugin);
			if (this.options.activity?.mentions?.stripText) {
				const options = this.options.activity?.mentions?.stripText;
				this.use(middleware.stripMentionsText(typeof options === "boolean" ? {} : options));
			}
			this.router.register({
				name: "signin.token-exchange",
				type: "system",
				select: (activity) => activity.type === "invoke" && activity.name === "signin/tokenExchange",
				callback: (ctx) => this.onTokenExchange(ctx)
			});
			this.router.register({
				name: "signin.verify-state",
				type: "system",
				select: (activity) => activity.type === "invoke" && activity.name === "signin/verifyState",
				callback: (ctx) => this.onVerifyState(ctx)
			});
			this.router.register({
				name: "signin.failure",
				type: "system",
				select: (activity) => activity.type === "invoke" && activity.name === "signin/failure",
				callback: (ctx) => this.onSignInFailure(ctx)
			});
			this.event("error", ({ error }) => {
				this.log.error(error.message);
				if (error instanceof axios_1.AxiosError) {
					this.log.error(error.request.path);
					this.log.error(error.response?.data);
				}
			});
		}
		/**
		* initialize the app.
		*/
		async initialize() {
			if (this.isInitialized) return;
			for (const plugin of this.plugins) {
				this.inject(plugin);
				if (plugin.onInit) await plugin.onInit();
			}
			await this.server.initialize({
				credentials: this.credentials,
				cloud: this.cloud
			});
			this.isInitialized = true;
		}
		/**
		* start the server after initialization
		* @param port port to listen on
		*/
		async start(port) {
			this.port = port || process.env.PORT || 3978;
			try {
				await this.initialize();
				for (const plugin of this.plugins) if (plugin.onStart) await plugin.onStart({ port: this.port });
				this.events.emit("start", this.log);
				await this.server.start(this.port);
			} catch (error) {
				await this.stop();
				this.onError({ error });
			}
		}
		/**
		* stop the app
		*/
		async stop() {
			try {
				for (const plugin of this.plugins) if (plugin.onStop) await plugin.onStop();
				await this.server.stop();
			} catch (error) {
				this.onError({ error });
			}
		}
		/**
		* send an activity proactively to a conversation.
		*
		* Sends to the exact conversation ID provided. For channel threads,
		* the conversation ID must include `;messageid=` - use {@link toThreadedConversationId}
		* to construct it, or use {@link reply} which handles this automatically.
		*
		* @param conversationId the conversation to send to
		* @param activity the activity to send
		*/
		async send(conversationId, activity) {
			if (!this.id) throw new Error("App has no credentials set up");
			const params = (0, teams_api_1.toActivityParams)(activity);
			const ref = {
				channelId: "msteams",
				serviceUrl: this.api.serviceUrl,
				bot: {
					id: this.id,
					name: this.name || this.id,
					role: "bot"
				},
				conversation: { id: conversationId }
			};
			return await this.activitySender.send(params, ref);
		}
		async reply(conversationId, messageId, activity) {
			if (typeof messageId === "string" && activity !== void 0) return this.send((0, thread_1.toThreadedConversationId)(conversationId, messageId), activity);
			return this.send(conversationId, messageId);
		}
		/**
		* subscribe to an event
		* @param name event to subscribe to
		* @param cb callback to invoke
		*/
		on = app_routing_1.on;
		/**
		* subscribe to a message event for a specific pattern
		* @param pattern pattern to match against message text
		* @param cb callback to invoke
		*/
		message = app_routing_1.message;
		/**
		* register a middleware
		* @param cb callback to invoke
		*/
		use = app_routing_1.use;
		/**
		* subscribe to an event
		* @param name the event to subscribe to
		* @param cb the callback to invoke
		*/
		event = app_events_1.event;
		/**
		* add a plugin
		* @param plugin plugin to add
		*/
		plugin = app_plugins_1.plugin;
		/**
		* get a plugin
		*/
		getPlugin = app_plugins_1.getPlugin;
		/**
		* add/update a function that can be called remotely
		* @param name The unique function name
		* @param cb The callback to handle the function
		*/
		function = app_embed_1.func;
		/**
		* add/update a static tab.
		* the tab will be hosted at
		* `http://localhost:{{PORT}}/tabs/{{name}}` or `https://{{BOT_DOMAIN}}/tabs/{{name}}`
		* @remark scopes default to `personal`
		* @param name A unique identifier for the entity which the tab displays.
		* @param path The path to the web `dist` folder.
		*/
		tab = app_embed_1.tab;
		/**
		* add a configurable tab
		* @remark scopes defaults to `team`
		* @param url The url to use when configuring the tab.
		*/
		configTab = app_embed_1.configTab;
		/**
		* activity handler called when an inbound activity is received
		* @param sender the plugin to use for sending activities
		* @param event the received activity event
		*/
		process = app_process_1.$process;
		onTokenExchange = app_oauth_1.onTokenExchange;
		onVerifyState = app_oauth_1.onVerifyState;
		onSignInFailure = app_oauth_1.onSignInFailure;
		inject = app_plugins_1.inject;
		onError = app_events_1.onError;
		onActivitySent = app_events_1.onActivitySent;
		onActivityResponse = app_events_1.onActivityResponse;
		async onActivity(event) {
			this.events.emit("activity", event);
			return await this.process(event);
		}
		async getBotToken() {
			if (!this.tokenManager) return;
			return await this.tokenManager.getBotToken();
		}
		async getUserToken(channelId, userId) {
			return (await this.api.users.token.get({
				channelId,
				userId,
				connectionName: this.oauth.defaultConnectionName
			})).token;
		}
		async getAppGraphToken(tenantId) {
			if (!this.tokenManager) return;
			return await this.tokenManager.getGraphToken(tenantId);
		}
	};
	exports.App = App;
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/plugins/http/plugin.js
var require_plugin = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __decorate = exports && exports.__decorate || function(decorators, target, key, desc) {
		var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
		if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
		else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
		return c > 3 && r && Object.defineProperty(target, key, r), r;
	};
	var __metadata = exports && exports.__metadata || function(k, v) {
		if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
	};
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HttpPlugin = void 0;
	const http_1 = __importDefault(__require("http"));
	const cors_1 = __importDefault(require_lib$1());
	const express_1 = __importDefault(__require("express"));
	const package_json_1 = __importDefault(require_package());
	const http_2 = require_http$1();
	const http_server_1 = require_http_server();
	const types_1 = require_types();
	/**
	* @deprecated Use the httpServerAdapter option instead:
	*   new App({ httpServerAdapter: new ExpressAdapter() })
	*
	* This wrapper will be removed in a future version.
	*
	* NOTE: This plugin is named "HttpPlugin" for historical reasons and backwards compatibility.
	* It is the default HTTP plugin that uses Express as the underlying framework.
	*/
	let HttpPlugin = class HttpPlugin {
		get;
		post;
		patch;
		put;
		delete;
		route;
		use;
		expressAdapter;
		server;
		constructor(server, options) {
			this.expressAdapter = new http_2.ExpressAdapter(server);
			this.server = new http_server_1.HttpServer(this.expressAdapter, {
				...options,
				messagingEndpoint: options?.messagingEndpoint ?? "/api/messages"
			});
			this.get = this.expressAdapter.get;
			this.post = this.expressAdapter.post;
			this.patch = this.expressAdapter.patch;
			this.put = this.expressAdapter.put;
			this.delete = this.expressAdapter.delete;
			this.route = this.expressAdapter.route;
			this.use = this.expressAdapter.use;
		}
		/**
		* App.constructor calls this to extract the HttpServer
		* @internal
		*/
		asServer() {
			return this.server;
		}
		/**
		* Plugin lifecycle hook
		*/
		async onInit() {
			this.use((0, cors_1.default)());
			this.use("/api", express_1.default.json());
		}
		/**
		* serve static files
		* @param path the url path to serve
		* @param dist the dist file path to serve
		*/
		static(path, dist) {
			this.expressAdapter.serveStatic(path, dist);
			return this;
		}
	};
	exports.HttpPlugin = HttpPlugin;
	exports.HttpPlugin = HttpPlugin = __decorate([(0, types_1.Plugin)({
		name: "http",
		version: package_json_1.default.version,
		description: "Deprecated: Use httpServerAdapter option instead"
	}), __metadata("design:paramtypes", [http_1.default.Server, Object])], HttpPlugin);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/plugins/http/index.js
var require_http = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$3) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$3, p)) __createBinding(exports$3, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_plugin(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/plugins/index.js
var require_plugins = /* @__PURE__ */ __commonJSMin(((exports) => {
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$2) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$2, p)) __createBinding(exports$2, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_http(), exports);
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/manifest.js
var require_manifest = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
}));
//#endregion
//#region node_modules/@microsoft/teams.apps/dist/index.js
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
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
	};
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toThreadedConversationId = exports.manifest = void 0;
	__exportStar(require_app(), exports);
	__exportStar(require_plugins(), exports);
	__exportStar(require_types(), exports);
	__exportStar(require_contexts(), exports);
	__exportStar(require_oauth(), exports);
	__exportStar(require_events(), exports);
	exports.manifest = __importStar(require_manifest());
	__exportStar(require_http$1(), exports);
	var thread_1 = require_thread();
	Object.defineProperty(exports, "toThreadedConversationId", {
		enumerable: true,
		get: function() {
			return thread_1.toThreadedConversationId;
		}
	});
}));
//#endregion
export default require_dist();
export {};
