export function definedFields<T extends object>(fields: T): T {
  for (const key in fields) {
    if (fields[key] === undefined) {
      delete fields[key];
    }
  }
  return fields;
}
