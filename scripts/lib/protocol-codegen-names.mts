export function upperCamel(value: string): string {
  const parts = value.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g);
  if (!parts?.length) {
    throw new Error(`Cannot create Kotlin identifier from ${JSON.stringify(value)}`);
  }
  return parts
    .map((part) => part.toLowerCase())
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function lowerCamel(value: string): string {
  const name = upperCamel(value);
  return name.charAt(0).toLowerCase() + name.slice(1);
}
