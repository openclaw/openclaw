"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.zodToJsonSchema = void 0;
const parseDef_1 = require("./parseDef.js");
const Refs_1 = require("./Refs.js");
const util_1 = require("./util.js");
const zodToJsonSchema = (schema, options) => {
    const refs = (0, Refs_1.getRefs)(options);
    const name = typeof options === 'string' ? options
        : options?.nameStrategy === 'title' ? undefined
            : options?.name;
    const main = (0, parseDef_1.parseDef)(schema._def, name === undefined ? refs : ({
        ...refs,
        currentPath: [...refs.basePath, refs.definitionPath, name],
    }), false) ?? {};
    const title = typeof options === 'object' && options.name !== undefined && options.nameStrategy === 'title' ?
        options.name
        : undefined;
    if (title !== undefined) {
        main.title = title;
    }
    const definitions = (() => {
        if ((0, util_1.isEmptyObj)(refs.definitions)) {
            return undefined;
        }
        const definitions = {};
        const processedDefinitions = new Set();
        // the call to `parseDef()` here might itself add more entries to `.definitions`
        // so we need to continually evaluate definitions until we've resolved all of them
        //
        // we have a generous iteration limit here to avoid blowing up the stack if there
        // are any bugs that would otherwise result in us iterating indefinitely
        for (let i = 0; i < 500; i++) {
            const newDefinitions = Object.entries(refs.definitions).filter(([key]) => !processedDefinitions.has(key));
            if (newDefinitions.length === 0)
                break;
            for (const [key, schema] of newDefinitions) {
                definitions[key] =
                    (0, parseDef_1.parseDef)((0, util_1.zodDef)(schema), { ...refs, currentPath: [...refs.basePath, refs.definitionPath, key] }, true) ?? {};
                processedDefinitions.add(key);
            }
        }
        return definitions;
    })();
    const combined = name === undefined ?
        definitions ?
            {
                ...main,
                [refs.definitionPath]: definitions,
            }
            : main
        : refs.nameStrategy === 'duplicate-ref' ?
            {
                ...main,
                ...(definitions || refs.seenRefs.size ?
                    {
                        [refs.definitionPath]: {
                            ...definitions,
                            // only actually duplicate the schema definition if it was ever referenced
                            // otherwise the duplication is completely pointless
                            ...(refs.seenRefs.size ? { [name]: main } : undefined),
                        },
                    }
                    : undefined),
            }
            : {
                $ref: [...(refs.$refStrategy === 'relative' ? [] : refs.basePath), refs.definitionPath, name].join('/'),
                [refs.definitionPath]: {
                    ...definitions,
                    [name]: main,
                },
            };
    if (refs.target === 'jsonSchema7') {
        combined.$schema = 'http://json-schema.org/draft-07/schema#';
    }
    else if (refs.target === 'jsonSchema2019-09') {
        combined.$schema = 'https://json-schema.org/draft/2019-09/schema#';
    }
    return combined;
};
exports.zodToJsonSchema = zodToJsonSchema;
//# sourceMappingURL=zodToJsonSchema.js.map