"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__setModuleDefault = exports.__createBinding = void 0;
exports.__classPrivateFieldSet = __classPrivateFieldSet;
exports.__classPrivateFieldGet = __classPrivateFieldGet;
exports.__exportStar = __exportStar;
exports.__importStar = __importStar;
function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m")
        throw new TypeError("Private method is not writable");
    if (kind === "a" && !f)
        throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
        throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f.call(receiver, value) : f ? (f.value = value) : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f)
        throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
        throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
var __createBinding = Object.create
    ? function (o, m, k, k2) {
        if (k2 === void 0)
            k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
            desc = {
                enumerable: true,
                get: function () {
                    return m[k];
                },
            };
        }
        Object.defineProperty(o, k2, desc);
    }
    : function (o, m, k, k2) {
        if (k2 === void 0)
            k2 = k;
        o[k2] = m[k];
    };
exports.__createBinding = __createBinding;
function __exportStar(m, o) {
    for (var p in m)
        if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p))
            __createBinding(o, m, p);
}
var __setModuleDefault = Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
    }
    : function (o, v) {
        o["default"] = v;
    };
exports.__setModuleDefault = __setModuleDefault;
var ownKeys = function (o) {
    ownKeys =
        Object.getOwnPropertyNames ||
            function (o2) {
                var ar = [];
                for (var k in o2)
                    if (Object.prototype.hasOwnProperty.call(o2, k))
                        ar[ar.length] = k;
                return ar;
            };
    return ownKeys(o);
};
function __importStar(mod) {
    if (mod && mod.__esModule)
        return mod;
    var result = {};
    if (mod != null) {
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
            if (k[i] !== "default")
                __createBinding(result, mod, k[i]);
    }
    __setModuleDefault(result, mod);
    return result;
}
