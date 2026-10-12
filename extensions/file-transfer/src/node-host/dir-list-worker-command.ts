const DIR_LIST_WORKER = [
  "(()=>{",
  'const fs=require("node:fs");',
  "const [directory,expected,device,inode,offsetText,maxText]=process.argv.slice(1);",
  "try{",
  "process.chdir(directory);",
  'if(fs.realpathSync(".")!==expected){process.exitCode=78;return;}',
  'const bound=fs.statSync(".",{bigint:true});',
  "if(String(bound.dev)!==device||String(bound.ino)!==inode){process.exitCode=78;return;}",
  'const all=fs.readdirSync(".",{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));',
  "const offset=Number(offsetText),max=Number(maxText);",
  "const entries=all.slice(offset,offset+max).map(entry=>{",
  "const stat=fs.lstatSync(entry.name);return{name:entry.name,isDirectory:stat.isDirectory(),isFile:stat.isFile(),size:stat.size,mtimeMs:stat.mtimeMs};",
  "});",
  "process.stdout.write(JSON.stringify({entries,total:all.length}));",
  "}catch{process.exitCode=1;}",
  "})();",
].join("");

export function createCanonicalDirListCommand(input: {
  directoryPath: string;
  expectedCanonicalPath: string;
  expectedDevice: string;
  expectedInode: string;
  maxEntries: number;
  offset: number;
}): string[] {
  return [
    process.execPath,
    "-e",
    DIR_LIST_WORKER,
    input.directoryPath,
    input.expectedCanonicalPath,
    input.expectedDevice,
    input.expectedInode,
    String(input.offset),
    String(input.maxEntries),
  ];
}
