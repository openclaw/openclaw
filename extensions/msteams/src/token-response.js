function readAccessToken(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const token = value.accessToken ?? value.token;
    return typeof token === "string" ? token : null;
  }
  return null;
}
export {
  readAccessToken
};
