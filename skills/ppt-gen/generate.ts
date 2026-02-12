import fs from "fs";
import path from "path";
import pptxgen from "pptxgenjs";

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
    const slidesData = JSON.parse(rawData);

    if (!Array.isArray(slidesData)) {
      throw new Error("Input JSON must be an array of slide objects.");
    }

    const pres = new pptxgen();

    // Default Layout
    pres.layout = "LAYOUT_16x9";

    // Loop through slides
    for (const slideInfo of slidesData) {
      const slide = pres.addSlide();

      // Title
      if (slideInfo.title) {
        slide.addText(slideInfo.title, {
          x: 0.5,
          y: 0.5,
          w: "90%",
          h: 1,
          fontSize: 24,
          bold: true,
          color: "000000",
        });
      }

      // Content Text
      if (slideInfo.text) {
        slide.addText(slideInfo.text, {
          x: 0.5,
          y: 1.5,
          w: "90%",
          h: 2,
          fontSize: 14,
          color: "333333",
        });
      }

      // Bullets
      if (Array.isArray(slideInfo.bullets)) {
        const bullets = slideInfo.bullets.map((b: string) => ({
          text: b,
          options: { bullet: true },
        }));
        slide.addText(bullets, {
          x: 0.5,
          y: 3.5,
          w: "90%",
          h: 3,
          fontSize: 14,
          color: "333333",
        });
      }

      // Image (Basic support)
      if (slideInfo.image) {
        slide.addImage({ path: slideInfo.image, x: 7, y: 1.5, w: 3, h: 3 });
      }
    }

    // Save
    // Ensure we write to an absolute path or relative to cwd
    const outputPath = path.resolve(process.cwd(), outputFilename);
    await pres.writeFile({ fileName: outputPath });

    console.log(`PPTX generated successfully: ${outputPath}`);
  } catch (err: any) {
    console.error("Error generating PPTX:", err.message);
    process.exit(1);
  }
}

main();
