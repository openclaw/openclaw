import { parseMotionSpecFromFile } from "../src/engine/parser/parseMotionSpecNode";
import { generateVariants } from "../src/engine/variants/generateVariants";

const base = parseMotionSpecFromFile("motion_specs/cutmv_premium_ad.json");
generateVariants(base);
console.log("Variants created in motion_specs/variants/");
