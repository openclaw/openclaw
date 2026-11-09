import io
import json
import subprocess
import tarfile

from settings import environment, settings

OPTIONS = settings()
ROOT, NODE, PNPM = (OPTIONS.root, str(OPTIONS.node), str(OPTIONS.pnpm))
ENV = environment(OPTIONS)
SOURCE = ROOT / 'source'
SOURCE.mkdir()
(ROOT / 'packages').mkdir()
deps = {}
for p in range(120):
    name = f'fixture-dep-{p:03d}'
    target = ROOT / 'packages' / f'{name}.tgz'
    with tarfile.open(target, 'w:gz', compresslevel=1) as archive:
        manifest = json.dumps({'name': name, 'version': '1.0.0', 'main': 'index.cjs'}).encode()
        entries = [
            ('package.json', manifest),
            ('index.cjs', f'module.exports = {p};\n'.encode()),
        ]
        for filename, data in entries:
            info = tarfile.TarInfo('package/' + filename)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
        for f in range(500):
            token = f'{p:03d}-{f:03d} synthetic dependency payload\n'.encode()
            data = (token * (17742 // len(token) + 1))[:17742]
            info = tarfile.TarInfo(f'package/lib/file-{f:03d}.txt')
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    deps[name] = 'file:' + str(target)
    if p % 20 == 0:
        print('package', p, flush=True)
for n in range(62000):
    directory = SOURCE / 'src' / str(n // 1000)
    directory.mkdir(exist_ok=True, parents=True)
    token = f'{n:05d} synthetic source payload\n'.encode()
    (directory / str(n)).write_bytes((token * (17742 // len(token) + 1))[:17742])
    if n % 10000 == 0:
        print('source', n, flush=True)
(SOURCE / 'version.cjs').write_text('module.exports = "base";\n')
(SOURCE / 'lifecycle.cjs').write_text(
    'const fs = require("node:fs"); fs.mkdirSync(".cache", {recursive:true}); '
    'fs.writeFileSync(".cache/lifecycle.txt", require("./version.cjs"));\n'
)
(SOURCE / 'test.cjs').write_text(
    'const assert = require("node:assert/strict"); const fs=require("node:fs"); '
    'assert.equal(require("./version.cjs"), "fork"); '
    'assert.equal(require("fixture-dep-000"),0); '
    'assert.equal(require("fixture-dep-119"),119); '
    'assert.equal(fs.readFileSync(".cache/lifecycle.txt","utf8"),"fork"); '
    'console.log("fork tests passed");\n'
)
(SOURCE / 'build.cjs').write_text(
    'const fs=require("node:fs"); const bytes=Buffer.alloc(1024*1024,7); '
    'for(const dir of ["dist",".cache/build"]) { '
    'fs.mkdirSync(dir,{recursive:true}); '
    'for(let i=0;i<8;i++) fs.writeFileSync(`${dir}/artifact-${i}`,bytes); }\n'
)
(SOURCE / 'package.json').write_text(json.dumps({
    'name': 'projection-write-fixture',
    'version': '1.0.0',
    'private': True,
    'dependencies': deps,
    'scripts': {
        'prepare': 'node lifecycle.cjs',
        'test': 'node test.cjs',
        'build': 'node build.cjs',
    },
}))
(SOURCE / 'pnpm-workspace.yaml').write_text(
    'packages: []\npackageImportMethod: clone-or-copy\nverifyDepsBeforeRun: false\n'
)
(SOURCE / '.gitignore').write_text('node_modules/\n.cache/\ndist/\n')
subprocess.run(
    [NODE, PNPM, 'install', '--lockfile-only', '--ignore-scripts', '--store-dir',
     str(ROOT / 'store/lock')],
    cwd=SOURCE, env=ENV, check=True,
)


def git(*args):
    return subprocess.check_output(['git', '-C', str(SOURCE), *args], env=ENV, text=True).strip()


git('init', '--quiet', '--template=', '-b', 'main')
git('config', 'user.name', 'Synthetic Fixture')
git('config', 'user.email', 'fixture@example.invalid')
git('add', '.')
git('commit', '--quiet', '-m', 'synthetic source')
base = git('rev-parse', 'HEAD')
git('checkout', '--quiet', '-b', 'fork-review')
(SOURCE / 'version.cjs').write_text('module.exports = "fork";\n')
git('commit', '--quiet', '-am', 'synthetic fork change')
fork = git('rev-parse', 'HEAD')
git('config', 'uploadpack.allowFilter', 'true')
git('config', 'uploadpack.allowAnySHA1InWant', 'true')
(ROOT / 'mount/packages').symlink_to('../packages')
(ROOT / 'manifest.json').write_text(json.dumps({
    'base': base,
    'fork': fork,
    'sourcePayloadBytes': 62000 * 17742,
    'dependencyPayloadBytes': 120 * 500 * 17742,
    'sourceFiles': 62000,
    'dependencyFiles': 60000,
    'fixture': 'synthetic, compression disabled',
}, indent=2))
print('prepared', base, fork, flush=True)
