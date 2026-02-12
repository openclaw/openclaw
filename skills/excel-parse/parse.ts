import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node parse.ts <input_file.xlsx>");
    process.exit(1);
  }

  const inputFile = args[0];

  try {
    const workbook = XLSX.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const data = XLSX.utils.sheet_to_json(sheet);

    console.log(JSON.stringify(data, null, 2));
  } catch (err: any) {
    console.error("Error parsing Excel:", err.message);
    process.exit(1);
  }
}

main();
