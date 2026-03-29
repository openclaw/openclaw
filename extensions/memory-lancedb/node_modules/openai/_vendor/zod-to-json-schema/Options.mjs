export const ignoreOverride = Symbol('Let zodToJsonSchema decide on which parser to use');
const defaultOptions = {
    name: undefined,
    $refStrategy: 'root',
    effectStrategy: 'input',
    pipeStrategy: 'all',
    dateStrategy: 'format:date-time',
    mapStrategy: 'entries',
    nullableStrategy: 'from-target',
    removeAdditionalStrategy: 'passthrough',
    definitionPath: 'definitions',
    target: 'jsonSchema7',
    strictUnions: false,
    errorMessages: false,
    markdownDescription: false,
    patternStrategy: 'escape',
    applyRegexFlags: false,
    emailStrategy: 'format:email',
    base64Strategy: 'contentEncoding:base64',
    nameStrategy: 'ref',
};
export const getDefaultOptions = (options) => {
    // We need to add `definitions` here as we may mutate it
    return (typeof options === 'string' ?
        {
            ...defaultOptions,
            basePath: ['#'],
            definitions: {},
            name: options,
        }
        : {
            ...defaultOptions,
            basePath: ['#'],
            definitions: {},
            ...options,
        });
};
//# sourceMappingURL=Options.mjs.map