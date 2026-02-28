app.displayDialogs = DialogModes.NO;

function fail(message) {
  throw new Error(message);
}

var inputPath = "__INPUT_PATH__";
var pngPath = "__PNG_PATH__";

var inputFile = new File(inputPath);
if (!inputFile.exists) {
  fail("E_FILE_NOT_FOUND: " + inputPath);
}

var doc = app.open(inputFile);
try {
  var outFile = new File(pngPath);
  var opts = new PNGSaveOptions();
  doc.saveAs(outFile, opts, true, Extension.LOWERCASE);
  doc.close(SaveOptions.DONOTSAVECHANGES);
} catch (e) {
  try {
    doc.close(SaveOptions.DONOTSAVECHANGES);
  } catch (_ignored) {}
  fail("E_EXPORT_FAILED: " + String(e && e.message ? e.message : e));
}
