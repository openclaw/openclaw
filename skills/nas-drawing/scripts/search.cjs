#!/usr/bin/env node
// NAS 图纸搜索脚本
// 用法: node search.cjs "图纸编号" [搜索目录]

const http = require("http");
const NAS = "http://192.168.3.106:5000";
const ACCOUNT = "openclaw";
const FOLDERS = [
  "/公司产品图档",
  "/前叉图档资料",
  "/模具图档",
  "/前期设计资料",
  "/比图仪用1：1图纸",
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login() {
  const r = await fetch(
    `${NAS}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${ACCOUNT}&passwd=&session=FileStation&format=cookie`,
  );
  if (!r.success) throw new Error("NAS login failed");
  return r.data.sid;
}

async function search(sid, folder, pattern) {
  const folderEnc = encodeURIComponent(folder);
  const patternEnc = encodeURIComponent(`*${pattern}*`);
  const r = await fetch(
    `${NAS}/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=start&folder_path=${folderEnc}&pattern=${patternEnc}&recursive=true&_sid=${sid}`,
  );
  if (!r.success) return [];
  const taskid = r.data.taskid;

  // Poll until finished, collect files along the way
  let files = [];
  for (let i = 0; i < 30; i++) {
    await sleep(i < 3 ? 2000 : 1000);
    const list = await fetch(
      `${NAS}/webapi/entry.cgi?api=SYNO.FileStation.Search&version=2&method=list&taskid=${taskid}&offset=0&limit=100&additional=${encodeURIComponent('["size","time","real_path"]')}&_sid=${sid}`,
    );
    if (list.data.files && list.data.files.length > 0) {
      files = list.data.files;
    }
    if (list.data.finished) {
      return files;
    }
  }
  return files;
}

async function main() {
  const keyword = process.argv[2];
  if (!keyword) {
    console.error('用法: node search.cjs "图纸编号"');
    process.exit(1);
  }

  const targetFolder = process.argv[3];
  const folders = targetFolder ? [targetFolder] : FOLDERS;

  console.error(`🔍 搜索图纸: ${keyword}`);
  const sid = await login();
  console.error(`✅ NAS 登录成功`);

  let allFiles = [];
  for (const folder of folders) {
    console.error(`📂 搜索目录: ${folder}`);
    const files = await search(sid, folder, keyword);
    if (files.length > 0) {
      allFiles = allFiles.concat(files);
      console.error(`   找到 ${files.length} 个文件`);
    }
  }

  if (allFiles.length === 0) {
    console.error("❌ 未找到匹配的图纸文件");
    process.exit(1);
  }

  // Output results as JSON
  for (const f of allFiles) {
    console.log(
      JSON.stringify({
        name: f.name,
        path: f.path,
        size: f.additional?.size || 0,
        mtime: f.additional?.time?.mtime || 0,
      }),
    );
  }
  console.error(`\n✅ 共找到 ${allFiles.length} 个文件`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
