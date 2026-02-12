import * as docx from "docx";
import fs from "fs";
import path from "path";

const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node generate.ts <output_filename> <input_json_file>");
    process.exit(1);
  }

  const outputFilename = args[0];
  const inputJsonFile = args[1];

  try {
    const rawData = fs.readFileSync(inputJsonFile, "utf-8");
    const docData = JSON.parse(rawData);

    const children: any[] = [];

    // Title
    if (docData.title) {
      children.push(
        new Paragraph({
          text: docData.title,
          heading: HeadingLevel.TITLE,
        }),
      );
    }

    // Sections
    if (Array.isArray(docData.sections)) {
      for (const section of docData.sections) {
        if (section.heading) {
          children.push(
            new Paragraph({
              text: section.heading,
              heading: HeadingLevel.HEADING_1,
              spacing: { before: 200 },
            }),
          );
        }

        if (section.text) {
          children.push(
            new Paragraph({
              children: [new TextRun(section.text)],
            }),
          );
        }

        if (Array.isArray(section.bullets)) {
          for (const point of section.bullets) {
            children.push(
              new Paragraph({
                text: point,
                bullet: { level: 0 },
              }),
            );
          }
        }
      }
    }

    const doc = new Document({
      sections: [
        {
          children: children,
        },
      ],
    });

    const outputPath = path.resolve(process.cwd(), outputFilename);
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    console.log(`DOCX generated successfully: ${outputPath}`);
  } catch (err: any) {
    console.error("Error generating DOCX:", err.message);
    process.exit(1);
  }
}

main();
