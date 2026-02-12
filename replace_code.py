import sys

with open("src/utils.test.ts", "r") as f:
    content = f.read()

search = """    const spy = vi
      .spyOn(fs, "readFileSync")
      // biome-ignore lint/suspicious/noExplicitAny: forwarding to native signature
      .mockImplementation((path: any, encoding?: any) => {
        if (path === mappingPath) {
          return `"5551234"`;
        }
        return original(path, encoding);
      });"""

replace = """    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(
        (
          path: PathOrFileDescriptor,
          encoding?: ObjectEncodingOptions | BufferEncoding | null,
        ) => {
          if (path === mappingPath) {
            return `"5551234"`;
          }
          return original(path, encoding as any);
        },
      );"""

if search in content:
    new_content = content.replace(search, replace)
    with open("src/utils.test.ts", "w") as f:
        f.write(new_content)
    print("Replaced successfully")
else:
    print("Search string not found")
    # print("Content around line 80:")
    # print(content[2500:3000]) # approximate location
