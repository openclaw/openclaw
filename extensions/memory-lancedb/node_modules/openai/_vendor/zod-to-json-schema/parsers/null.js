"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseNullDef = parseNullDef;
function parseNullDef(refs) {
    return refs.target === 'openApi3' ?
        {
            enum: ['null'],
            nullable: true,
        }
        : {
            type: 'null',
        };
}
//# sourceMappingURL=null.js.map