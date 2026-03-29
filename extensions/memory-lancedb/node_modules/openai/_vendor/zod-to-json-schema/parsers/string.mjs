import { setResponseValueAndErrors } from "../errorMessages.mjs";
let emojiRegex;
/**
 * Generated from the regular expressions found here as of 2024-05-22:
 * https://github.com/colinhacks/zod/blob/master/src/types.ts.
 *
 * Expressions with /i flag have been changed accordingly.
 */
export const zodPatterns = {
    /**
     * `c` was changed to `[cC]` to replicate /i flag
     */
    cuid: /^[cC][^\s-]{8,}$/,
    cuid2: /^[0-9a-z]+$/,
    ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
    /**
     * `a-z` was added to replicate /i flag
     */
    email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/,
    /**
     * Constructed a valid Unicode RegExp
     *
     * Lazily instantiate since this type of regex isn't supported
     * in all envs (e.g. React Native).
     *
     * See:
     * https://github.com/colinhacks/zod/issues/2433
     * Fix in Zod:
     * https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
     */
    emoji: () => {
        if (emojiRegex === undefined) {
            emojiRegex = RegExp('^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$', 'u');
        }
        return emojiRegex;
    },
    /**
     * Unused
     */
    uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
    /**
     * Unused
     */
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
    /**
     * Unused
     */
    ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
    base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
    nanoid: /^[a-zA-Z0-9_-]{21}$/,
};
export function parseStringDef(def, refs) {
    const res = {
        type: 'string',
    };
    function processPattern(value) {
        return refs.patternStrategy === 'escape' ? escapeNonAlphaNumeric(value) : value;
    }
    if (def.checks) {
        for (const check of def.checks) {
            switch (check.kind) {
                case 'min':
                    setResponseValueAndErrors(res, 'minLength', typeof res.minLength === 'number' ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
                    break;
                case 'max':
                    setResponseValueAndErrors(res, 'maxLength', typeof res.maxLength === 'number' ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
                    break;
                case 'email':
                    switch (refs.emailStrategy) {
                        case 'format:email':
                            addFormat(res, 'email', check.message, refs);
                            break;
                        case 'format:idn-email':
                            addFormat(res, 'idn-email', check.message, refs);
                            break;
                        case 'pattern:zod':
                            addPattern(res, zodPatterns.email, check.message, refs);
                            break;
                    }
                    break;
                case 'url':
                    addFormat(res, 'uri', check.message, refs);
                    break;
                case 'uuid':
                    addFormat(res, 'uuid', check.message, refs);
                    break;
                case 'regex':
                    addPattern(res, check.regex, check.message, refs);
                    break;
                case 'cuid':
                    addPattern(res, zodPatterns.cuid, check.message, refs);
                    break;
                case 'cuid2':
                    addPattern(res, zodPatterns.cuid2, check.message, refs);
                    break;
                case 'startsWith':
                    addPattern(res, RegExp(`^${processPattern(check.value)}`), check.message, refs);
                    break;
                case 'endsWith':
                    addPattern(res, RegExp(`${processPattern(check.value)}$`), check.message, refs);
                    break;
                case 'datetime':
                    addFormat(res, 'date-time', check.message, refs);
                    break;
                case 'date':
                    addFormat(res, 'date', check.message, refs);
                    break;
                case 'time':
                    addFormat(res, 'time', check.message, refs);
                    break;
                case 'duration':
                    addFormat(res, 'duration', check.message, refs);
                    break;
                case 'length':
                    setResponseValueAndErrors(res, 'minLength', typeof res.minLength === 'number' ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
                    setResponseValueAndErrors(res, 'maxLength', typeof res.maxLength === 'number' ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
                    break;
                case 'includes': {
                    addPattern(res, RegExp(processPattern(check.value)), check.message, refs);
                    break;
                }
                case 'ip': {
                    if (check.version !== 'v6') {
                        addFormat(res, 'ipv4', check.message, refs);
                    }
                    if (check.version !== 'v4') {
                        addFormat(res, 'ipv6', check.message, refs);
                    }
                    break;
                }
                case 'emoji':
                    addPattern(res, zodPatterns.emoji, check.message, refs);
                    break;
                case 'ulid': {
                    addPattern(res, zodPatterns.ulid, check.message, refs);
                    break;
                }
                case 'base64': {
                    switch (refs.base64Strategy) {
                        case 'format:binary': {
                            addFormat(res, 'binary', check.message, refs);
                            break;
                        }
                        case 'contentEncoding:base64': {
                            setResponseValueAndErrors(res, 'contentEncoding', 'base64', check.message, refs);
                            break;
                        }
                        case 'pattern:zod': {
                            addPattern(res, zodPatterns.base64, check.message, refs);
                            break;
                        }
                    }
                    break;
                }
                case 'nanoid': {
                    addPattern(res, zodPatterns.nanoid, check.message, refs);
                }
                case 'toLowerCase':
                case 'toUpperCase':
                case 'trim':
                    break;
                default:
                    ((_) => { })(check);
            }
        }
    }
    return res;
}
const escapeNonAlphaNumeric = (value) => Array.from(value)
    .map((c) => (/[a-zA-Z0-9]/.test(c) ? c : `\\${c}`))
    .join('');
const addFormat = (schema, value, message, refs) => {
    if (schema.format || schema.anyOf?.some((x) => x.format)) {
        if (!schema.anyOf) {
            schema.anyOf = [];
        }
        if (schema.format) {
            schema.anyOf.push({
                format: schema.format,
                ...(schema.errorMessage &&
                    refs.errorMessages && {
                    errorMessage: { format: schema.errorMessage.format },
                }),
            });
            delete schema.format;
            if (schema.errorMessage) {
                delete schema.errorMessage.format;
                if (Object.keys(schema.errorMessage).length === 0) {
                    delete schema.errorMessage;
                }
            }
        }
        schema.anyOf.push({
            format: value,
            ...(message && refs.errorMessages && { errorMessage: { format: message } }),
        });
    }
    else {
        setResponseValueAndErrors(schema, 'format', value, message, refs);
    }
};
const addPattern = (schema, regex, message, refs) => {
    if (schema.pattern || schema.allOf?.some((x) => x.pattern)) {
        if (!schema.allOf) {
            schema.allOf = [];
        }
        if (schema.pattern) {
            schema.allOf.push({
                pattern: schema.pattern,
                ...(schema.errorMessage &&
                    refs.errorMessages && {
                    errorMessage: { pattern: schema.errorMessage.pattern },
                }),
            });
            delete schema.pattern;
            if (schema.errorMessage) {
                delete schema.errorMessage.pattern;
                if (Object.keys(schema.errorMessage).length === 0) {
                    delete schema.errorMessage;
                }
            }
        }
        schema.allOf.push({
            pattern: processRegExp(regex, refs),
            ...(message && refs.errorMessages && { errorMessage: { pattern: message } }),
        });
    }
    else {
        setResponseValueAndErrors(schema, 'pattern', processRegExp(regex, refs), message, refs);
    }
};
// Mutate z.string.regex() in a best attempt to accommodate for regex flags when applyRegexFlags is true
const processRegExp = (regexOrFunction, refs) => {
    const regex = typeof regexOrFunction === 'function' ? regexOrFunction() : regexOrFunction;
    if (!refs.applyRegexFlags || !regex.flags)
        return regex.source;
    // Currently handled flags
    const flags = {
        i: regex.flags.includes('i'), // Case-insensitive
        m: regex.flags.includes('m'), // `^` and `$` matches adjacent to newline characters
        s: regex.flags.includes('s'), // `.` matches newlines
    };
    // The general principle here is to step through each character, one at a time, applying mutations as flags require. We keep track when the current character is escaped, and when it's inside a group /like [this]/ or (also) a range like /[a-z]/. The following is fairly brittle imperative code; edit at your peril!
    const source = flags.i ? regex.source.toLowerCase() : regex.source;
    let pattern = '';
    let isEscaped = false;
    let inCharGroup = false;
    let inCharRange = false;
    for (let i = 0; i < source.length; i++) {
        if (isEscaped) {
            pattern += source[i];
            isEscaped = false;
            continue;
        }
        if (flags.i) {
            if (inCharGroup) {
                if (source[i].match(/[a-z]/)) {
                    if (inCharRange) {
                        pattern += source[i];
                        pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
                        inCharRange = false;
                    }
                    else if (source[i + 1] === '-' && source[i + 2]?.match(/[a-z]/)) {
                        pattern += source[i];
                        inCharRange = true;
                    }
                    else {
                        pattern += `${source[i]}${source[i].toUpperCase()}`;
                    }
                    continue;
                }
            }
            else if (source[i].match(/[a-z]/)) {
                pattern += `[${source[i]}${source[i].toUpperCase()}]`;
                continue;
            }
        }
        if (flags.m) {
            if (source[i] === '^') {
                pattern += `(^|(?<=[\r\n]))`;
                continue;
            }
            else if (source[i] === '$') {
                pattern += `($|(?=[\r\n]))`;
                continue;
            }
        }
        if (flags.s && source[i] === '.') {
            pattern += inCharGroup ? `${source[i]}\r\n` : `[${source[i]}\r\n]`;
            continue;
        }
        pattern += source[i];
        if (source[i] === '\\') {
            isEscaped = true;
        }
        else if (inCharGroup && source[i] === ']') {
            inCharGroup = false;
        }
        else if (!inCharGroup && source[i] === '[') {
            inCharGroup = true;
        }
    }
    try {
        const regexTest = new RegExp(pattern);
    }
    catch {
        console.warn(`Could not convert regex pattern at ${refs.currentPath.join('/')} to a flag-independent form! Falling back to the flag-ignorant source`);
        return regex.source;
    }
    return pattern;
};
//# sourceMappingURL=string.mjs.map