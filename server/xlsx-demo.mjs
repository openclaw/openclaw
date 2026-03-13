// Demo: Read Azure_Bay_Residences_Demo_Data_850_Units.xlsx and print first 5 rows
import xlsx from 'xlsx';
import path from 'path';

const filePath = path.resolve('../Azure_Bay_Residences_Demo_Data_850_Units.xlsx');
const workbook = xlsx.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(sheet);

console.log(data.slice(0, 5));
