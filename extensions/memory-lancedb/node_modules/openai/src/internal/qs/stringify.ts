import { encode, is_buffer, maybe_map, has } from './utils';
import { default_format, default_formatter, formatters } from './formats';
import type { NonNullableProperties, StringifyOptions } from './types';
import { isArray } from '../utils/values';

const array_prefix_generators = {
  brackets(prefix: PropertyKey) {
    return String(prefix) + '[]';
  },
  comma: 'comma',
  indices(prefix: PropertyKey, key: string) {
    return String(prefix) + '[' + key + ']';
  },
  repeat(prefix: PropertyKey) {
    return String(prefix);
  },
};

const push_to_array = function (arr: any[], value_or_array: any) {
  Array.prototype.push.apply(arr, isArray(value_or_array) ? value_or_array : [value_or_array]);
};

let toISOString;

const defaults = {
  addQueryPrefix: false,
  allowDots: false,
  allowEmptyArrays: false,
  arrayFormat: 'indices',
  charset: 'utf-8',
  charsetSentinel: false,
  delimiter: '&',
  encode: true,
  encodeDotInKeys: false,
  encoder: encode,
  encodeValuesOnly: false,
  format: default_format,
  formatter: default_formatter,
  /** @deprecated */
  indices: false,
  serializeDate(date) {
    return (toISOString ??= Function.prototype.call.bind(Date.prototype.toISOString))(date);
  },
  skipNulls: false,
  strictNullHandling: false,
} as NonNullableProperties<StringifyOptions & { formatter: (typeof formatters)['RFC1738'] }>;

function is_non_nullish_primitive(v: unknown): v is string | number | boolean | symbol | bigint {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'symbol' ||
    typeof v === 'bigint'
  );
}

const sentinel = {};

function inner_stringify(
  object: any,
  prefix: PropertyKey,
  generateArrayPrefix: StringifyOptions['arrayFormat'] | ((prefix: string, key: string) => string),
  commaRoundTrip: boolean,
  allowEmptyArrays: boolean,
  strictNullHandling: boolean,
  skipNulls: boolean,
  encodeDotInKeys: boolean,
  encoder: StringifyOptions['encoder'],
  filter: StringifyOptions['filter'],
  sort: StringifyOptions['sort'],
  allowDots: StringifyOptions['allowDots'],
  serializeDate: StringifyOptions['serializeDate'],
  format: StringifyOptions['format'],
  formatter: StringifyOptions['formatter'],
  encodeValuesOnly: boolean,
  charset: StringifyOptions['charset'],
  sideChannel: WeakMap<any, any>,
) {
  let obj = object;

  let tmp_sc = sideChannel;
  let step = 0;
  let find_flag = false;
  while ((tmp_sc = tmp_sc.get(sentinel)) !== void undefined && !find_flag) {
    // Where object last appeared in the ref tree
    const pos = tmp_sc.get(object);
    step += 1;
    if (typeof pos !== 'undefined') {
      if (pos === step) {
        throw new RangeError('Cyclic object value');
      } else {
        find_flag = true; // Break while
      }
    }
    if (typeof tmp_sc.get(sentinel) === 'undefined') {
      step = 0;
    }
  }

  if (typeof filter === 'function') {
    obj = filter(prefix, obj);
  } else if (obj instanceof Date) {
    obj = serializeDate?.(obj);
  } else if (generateArrayPrefix === 'comma' && isArray(obj)) {
    obj = maybe_map(obj, function (value) {
      if (value instanceof Date) {
        return serializeDate?.(value);
      }
      return value;
    });
  }

  if (obj === null) {
    if (strictNullHandling) {
      return encoder && !encodeValuesOnly ?
          // @ts-expect-error
          encoder(prefix, defaults.encoder, charset, 'key', format)
        : prefix;
    }

    obj = '';
  }

  if (is_non_nullish_primitive(obj) || is_buffer(obj)) {
    if (encoder) {
      const key_value =
        encodeValuesOnly ? prefix
          // @ts-expect-error
        : encoder(prefix, defaults.encoder, charset, 'key', format);
      return [
        formatter?.(key_value) +
          '=' +
          // @ts-expect-error
          formatter?.(encoder(obj, defaults.encoder, charset, 'value', format)),
      ];
    }
    return [formatter?.(prefix) + '=' + formatter?.(String(obj))];
  }

  const values: string[] = [];

  if (typeof obj === 'undefined') {
    return values;
  }

  let obj_keys;
  if (generateArrayPrefix === 'comma' && isArray(obj)) {
    // we need to join elements in
    if (encodeValuesOnly && encoder) {
      // @ts-expect-error values only
      obj = maybe_map(obj, encoder);
    }
    obj_keys = [{ value: obj.length > 0 ? obj.join(',') || null : void undefined }];
  } else if (isArray(filter)) {
    obj_keys = filter;
  } else {
    const keys = Object.keys(obj);
    obj_keys = sort ? keys.sort(sort) : keys;
  }

  const encoded_prefix = encodeDotInKeys ? String(prefix).replace(/\./g, '%2E') : String(prefix);

  const adjusted_prefix =
    commaRoundTrip && isArray(obj) && obj.length === 1 ? encoded_prefix + '[]' : encoded_prefix;

  if (allowEmptyArrays && isArray(obj) && obj.length === 0) {
    return adjusted_prefix + '[]';
  }

  for (let j = 0; j < obj_keys.length; ++j) {
    const key = obj_keys[j];
    const value =
      // @ts-ignore
      typeof key === 'object' && typeof key.value !== 'undefined' ? key.value : obj[key as any];

    if (skipNulls && value === null) {
      continue;
    }

    // @ts-ignore
    const encoded_key = allowDots && encodeDotInKeys ? (key as any).replace(/\./g, '%2E') : key;
    const key_prefix =
      isArray(obj) ?
        typeof generateArrayPrefix === 'function' ?
          generateArrayPrefix(adjusted_prefix, encoded_key)
        : adjusted_prefix
      : adjusted_prefix + (allowDots ? '.' + encoded_key : '[' + encoded_key + ']');

    sideChannel.set(object, step);
    const valueSideChannel = new WeakMap();
    valueSideChannel.set(sentinel, sideChannel);
    push_to_array(
      values,
      inner_stringify(
        value,
        key_prefix,
        generateArrayPrefix,
        commaRoundTrip,
        allowEmptyArrays,
        strictNullHandling,
        skipNulls,
        encodeDotInKeys,
        // @ts-ignore
        generateArrayPrefix === 'comma' && encodeValuesOnly && isArray(obj) ? null : encoder,
        filter,
        sort,
        allowDots,
        serializeDate,
        format,
        formatter,
        encodeValuesOnly,
        charset,
        valueSideChannel,
      ),
    );
  }

  return values;
}

function normalize_stringify_options(
  opts: StringifyOptions = defaults,
): NonNullableProperties<Omit<StringifyOptions, 'indices'>> & { indices?: boolean } {
  if (typeof opts.allowEmptyArrays !== 'undefined' && typeof opts.allowEmptyArrays !== 'boolean') {
    throw new TypeError('`allowEmptyArrays` option can only be `true` or `false`, when provided');
  }

  if (typeof opts.encodeDotInKeys !== 'undefined' && typeof opts.encodeDotInKeys !== 'boolean') {
    throw new TypeError('`encodeDotInKeys` option can only be `true` or `false`, when provided');
  }

  if (opts.encoder !== null && typeof opts.encoder !== 'undefined' && typeof opts.encoder !== 'function') {
    throw new TypeError('Encoder has to be a function.');
  }

  const charset = opts.charset || defaults.charset;
  if (typeof opts.charset !== 'undefined' && opts.charset !== 'utf-8' && opts.charset !== 'iso-8859-1') {
    throw new TypeError('The charset option must be either utf-8, iso-8859-1, or undefined');
  }

  let format = default_format;
  if (typeof opts.format !== 'undefined') {
    if (!has(formatters, opts.format)) {
      throw new TypeError('Unknown format option provided.');
    }
    format = opts.format;
  }
  const formatter = formatters[format];

  let filter = defaults.filter;
  if (typeof opts.filter === 'function' || isArray(opts.filter)) {
    filter = opts.filter;
  }

  let arrayFormat: StringifyOptions['arrayFormat'];
  if (opts.arrayFormat && opts.arrayFormat in array_prefix_generators) {
    arrayFormat = opts.arrayFormat;
  } else if ('indices' in opts) {
    arrayFormat = opts.indices ? 'indices' : 'repeat';
  } else {
    arrayFormat = defaults.arrayFormat;
  }

  if ('commaRoundTrip' in opts && typeof opts.commaRoundTrip !== 'boolean') {
    throw new TypeError('`commaRoundTrip` must be a boolean, or absent');
  }

  const allowDots =
    typeof opts.allowDots === 'undefined' ?
      !!opts.encodeDotInKeys === true ?
        true
      : defaults.allowDots
    : !!opts.allowDots;

  return {
    addQueryPrefix: typeof opts.addQueryPrefix === 'boolean' ? opts.addQueryPrefix : defaults.addQueryPrefix,
    // @ts-ignore
    allowDots: allowDots,
    allowEmptyArrays:
      typeof opts.allowEmptyArrays === 'boolean' ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
    arrayFormat: arrayFormat,
    charset: charset,
    charsetSentinel:
      typeof opts.charsetSentinel === 'boolean' ? opts.charsetSentinel : defaults.charsetSentinel,
    commaRoundTrip: !!opts.commaRoundTrip,
    delimiter: typeof opts.delimiter === 'undefined' ? defaults.delimiter : opts.delimiter,
    encode: typeof opts.encode === 'boolean' ? opts.encode : defaults.encode,
    encodeDotInKeys:
      typeof opts.encodeDotInKeys === 'boolean' ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
    encoder: typeof opts.encoder === 'function' ? opts.encoder : defaults.encoder,
    encodeValuesOnly:
      typeof opts.encodeValuesOnly === 'boolean' ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
    filter: filter,
    format: format,
    formatter: formatter,
    serializeDate: typeof opts.serializeDate === 'function' ? opts.serializeDate : defaults.serializeDate,
    skipNulls: typeof opts.skipNulls === 'boolean' ? opts.skipNulls : defaults.skipNulls,
    // @ts-ignore
    sort: typeof opts.sort === 'function' ? opts.sort : null,
    strictNullHandling:
      typeof opts.strictNullHandling === 'boolean' ? opts.strictNullHandling : defaults.strictNullHandling,
  };
}

export function stringify(object: any, opts: StringifyOptions = {}) {
  let obj = object;
  const options = normalize_stringify_options(opts);

  let obj_keys: PropertyKey[] | undefined;
  let filter;

  if (typeof options.filter === 'function') {
    filter = options.filter;
    obj = filter('', obj);
  } else if (isArray(options.filter)) {
    filter = options.filter;
    obj_keys = filter;
  }

  const keys: string[] = [];

  if (typeof obj !== 'object' || obj === null) {
    return '';
  }

  const generateArrayPrefix = array_prefix_generators[options.arrayFormat];
  const commaRoundTrip = generateArrayPrefix === 'comma' && options.commaRoundTrip;

  if (!obj_keys) {
    obj_keys = Object.keys(obj);
  }

  if (options.sort) {
    obj_keys.sort(options.sort);
  }

  const sideChannel = new WeakMap();
  for (let i = 0; i < obj_keys.length; ++i) {
    const key = obj_keys[i]!;

    if (options.skipNulls && obj[key] === null) {
      continue;
    }
    push_to_array(
      keys,
      inner_stringify(
        obj[key],
        key,
        // @ts-expect-error
        generateArrayPrefix,
        commaRoundTrip,
        options.allowEmptyArrays,
        options.strictNullHandling,
        options.skipNulls,
        options.encodeDotInKeys,
        options.encode ? options.encoder : null,
        options.filter,
        options.sort,
        options.allowDots,
        options.serializeDate,
        options.format,
        options.formatter,
        options.encodeValuesOnly,
        options.charset,
        sideChannel,
      ),
    );
  }

  const joined = keys.join(options.delimiter);
  let prefix = options.addQueryPrefix === true ? '?' : '';

  if (options.charsetSentinel) {
    if (options.charset === 'iso-8859-1') {
      // encodeURIComponent('&#10003;'), the "numeric entity" representation of a checkmark
      prefix += 'utf8=%26%2310003%3B&';
    } else {
      // encodeURIComponent('✓')
      prefix += 'utf8=%E2%9C%93&';
    }
  }

  return joined.length > 0 ? prefix + joined : '';
}
