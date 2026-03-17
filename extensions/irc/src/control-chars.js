function isIrcControlChar(charCode) {
  return charCode <= 31 || charCode === 127;
}
function hasIrcControlChars(value) {
  for (const char of value) {
    if (isIrcControlChar(char.charCodeAt(0))) {
      return true;
    }
  }
  return false;
}
function stripIrcControlChars(value) {
  let out = "";
  for (const char of value) {
    if (!isIrcControlChar(char.charCodeAt(0))) {
      out += char;
    }
  }
  return out;
}
export {
  hasIrcControlChars,
  isIrcControlChar,
  stripIrcControlChars
};
