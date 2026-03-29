"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParsingToolFunction = void 0;
exports.isRunnableFunctionWithParse = isRunnableFunctionWithParse;
function isRunnableFunctionWithParse(fn) {
    return typeof fn.parse === 'function';
}
/**
 * This is helper class for passing a `function` and `parse` where the `function`
 * argument type matches the `parse` return type.
 */
class ParsingToolFunction {
    constructor(input) {
        this.type = 'function';
        this.function = input;
    }
}
exports.ParsingToolFunction = ParsingToolFunction;
//# sourceMappingURL=RunnableFunction.js.map