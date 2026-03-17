function getHeader(headers, name) {
  const target = name.toLowerCase();
  const direct = headers[target];
  const value = direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
export {
  getHeader
};
