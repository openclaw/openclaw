"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zodDef = void 0;
exports.isEmptyObj = isEmptyObj;
const zodDef = (zodSchema) => {
    return '_def' in zodSchema ? zodSchema._def : zodSchema;
};
exports.zodDef = zodDef;
function isEmptyObj(obj) {
    if (!obj)
        return true;
    for (const _k in obj)
        return false;
    return true;
}
//# sourceMappingURL=util.js.map