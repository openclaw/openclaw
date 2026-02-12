import sys

with open("src/utils.test.ts", "r") as f:
    lines = f.readlines()

start_index = -1
for i, line in enumerate(lines):
    if '.spyOn(fs, "readFileSync")' in line:
        start_index = i
        break

if start_index != -1:
    # Check next lines
    if "biome-ignore lint/suspicious/noExplicitAny" in lines[start_index + 1]:
        # Found it
        # Lines to remove: start_index + 1 (comment) to start_index + 7 (closing brace + semicolon)
        # But wait, lines[start_index] is the spyOn line.
        # Lines involved:
        # start_index: spyOn
        # start_index + 1: biome-ignore
        # start_index + 2: mockImplementation start
        # ...
        # start_index + 7: closing brace

        # Verify the block ends where we expect
        if "spy.mockRestore();" in lines[start_index + 9]: # Check context
             pass

        # Construct new block
        new_block = [
            '      .mockImplementation((path: PathOrFileDescriptor, encoding?: ObjectEncodingOptions | BufferEncoding | null) => {\n',
            '        if (path === mappingPath) {\n',
            '          return ;\n',
            '        }\n',
            '        return original(path, encoding as any);\n',
            '      });\n'
        ]

        # Replace lines start_index + 1 to start_index + 7 (inclusive)
        # Old lines:
        # 84: // biome-ignore ...
        # 85: .mockImplementation((path: any, encoding?: any) => {
        # 86: if (path === mappingPath) {
        # 87: return ;
        # 88: }
        # 89: return original(path, encoding);
        # 90: });

        # So we replace 6 lines starting from start_index + 1 with new_block

        del lines[start_index + 1 : start_index + 8] # 7 lines to remove? 84-90 is 7 lines.
        # Let's count again:
        # 84 (1)
        # 85 (2)
        # 86 (3)
        # 87 (4)
        # 88 (5)
        # 89 (6)
        # 90 (7)

        # Insert new block
        for j, new_line in enumerate(new_block):
            lines.insert(start_index + 1 + j, new_line)

        with open("src/utils.test.ts", "w") as f:
            f.writelines(lines)
        print("Replaced successfully")
    else:
        print("Biome ignore line not found at expected position")
else:
    print("spyOn line not found")
