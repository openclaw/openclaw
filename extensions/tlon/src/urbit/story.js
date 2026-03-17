function parseInlineMarkdown(text) {
  const result = [];
  let remaining = text;
  while (remaining.length > 0) {
    const shipMatch = remaining.match(/^(~[a-z][-a-z0-9]*)/);
    if (shipMatch) {
      result.push({ ship: shipMatch[1] });
      remaining = remaining.slice(shipMatch[0].length);
      continue;
    }
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
    if (boldMatch) {
      const content = boldMatch[1] || boldMatch[2];
      result.push({ bold: parseInlineMarkdown(content) });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    const italicsMatch = remaining.match(/^\*([^*]+?)\*|^_([^_]+?)_(?![a-zA-Z0-9])/);
    if (italicsMatch) {
      const content = italicsMatch[1] || italicsMatch[2];
      result.push({ italics: parseInlineMarkdown(content) });
      remaining = remaining.slice(italicsMatch[0].length);
      continue;
    }
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      result.push({ strike: parseInlineMarkdown(strikeMatch[1]) });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      result.push({ "inline-code": codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      result.push({ link: { href: linkMatch[2], content: linkMatch[1] } });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }
    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      result.push({
        __image: { src: imageMatch[2], alt: imageMatch[1] }
      });
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }
    const urlMatch = remaining.match(/^(https?:\/\/[^\s<>"\]]+)/);
    if (urlMatch) {
      result.push({ link: { href: urlMatch[1], content: urlMatch[1] } });
      remaining = remaining.slice(urlMatch[0].length);
      continue;
    }
    const plainMatch = remaining.match(/^[^*_`~[#~\n:/]+/);
    if (plainMatch) {
      result.push(plainMatch[0]);
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }
    result.push(remaining[0]);
    remaining = remaining.slice(1);
  }
  return mergeAdjacentStrings(result);
}
function mergeAdjacentStrings(inlines) {
  const result = [];
  for (const item of inlines) {
    if (typeof item === "string" && typeof result[result.length - 1] === "string") {
      result[result.length - 1] = result[result.length - 1] + item;
    } else {
      result.push(item);
    }
  }
  return result;
}
function createImageBlock(src, alt = "", height = 0, width = 0) {
  return {
    block: {
      image: { src, height, width, alt }
    }
  };
}
function isImageUrl(url) {
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i;
  return imageExtensions.test(url);
}
function processInlinesForImages(inlines) {
  const cleanInlines = [];
  const imageBlocks = [];
  for (const inline of inlines) {
    if (typeof inline === "object" && "__image" in inline) {
      const img = inline.__image;
      imageBlocks.push(createImageBlock(img.src, img.alt));
    } else {
      cleanInlines.push(inline);
    }
  }
  return { inlines: cleanInlines, imageBlocks };
}
function markdownToStory(markdown) {
  const story = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plaintext";
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      story.push({
        block: {
          code: {
            code: codeLines.join("\n"),
            lang
          }
        }
      });
      i++;
      continue;
    }
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const tag = `h${level}`;
      story.push({
        block: {
          header: {
            tag,
            content: parseInlineMarkdown(headerMatch[2])
          }
        }
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      story.push({ block: { rule: null } });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      const quoteText = quoteLines.join("\n");
      story.push({
        inline: [{ blockquote: parseInlineMarkdown(quoteText) }]
      });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paragraphLines = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
      paragraphLines.push(lines[i]);
      i++;
    }
    if (paragraphLines.length > 0) {
      const paragraphText = paragraphLines.join("\n");
      const inlines = parseInlineMarkdown(paragraphText);
      const withBreaks = [];
      for (const inline of inlines) {
        if (typeof inline === "string" && inline.includes("\n")) {
          const parts = inline.split("\n");
          for (let j = 0; j < parts.length; j++) {
            if (parts[j]) {
              withBreaks.push(parts[j]);
            }
            if (j < parts.length - 1) {
              withBreaks.push({ break: null });
            }
          }
        } else {
          withBreaks.push(inline);
        }
      }
      const { inlines: cleanInlines, imageBlocks } = processInlinesForImages(withBreaks);
      if (cleanInlines.length > 0) {
        story.push({ inline: cleanInlines });
      }
      story.push(...imageBlocks);
    }
  }
  return story;
}
function textToStory(text) {
  return [{ inline: [text] }];
}
function hasMarkdown(text) {
  return /(\*\*|__|~~|`|^#{1,6}\s|^```|^\s*[-*]\s|\[.*\]\(.*\)|^>\s)/m.test(text);
}
export {
  createImageBlock,
  hasMarkdown,
  isImageUrl,
  markdownToStory,
  textToStory
};
