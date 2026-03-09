"""Final cleanup - fix remaining 6 Korean lines."""
import os

os.chdir(r"C:\TEST\M.AI.UPbit")

# test_cli.py: 1 line
with open("tests/unit/test_cli.py", encoding="utf-8") as f:
    c = f.read()
c = c.replace("\uc815\uc0c1 \uc885\ub8cc", "normal exit")  # 정상 종료
c = c.replace("\uc5c6\uc774", "without")  # 없이
with open("tests/unit/test_cli.py", "w", encoding="utf-8") as f:
    f.write(c)
print("test_cli.py: done")

# test_knowledge.py: 5 lines
with open("tests/unit/test_knowledge.py", encoding="utf-8") as f:
    c = f.read()
c = c.replace("\ube44\ud2b8\ucf54\uc778 \ud22c\uc790", "bitcoin investment")  # 비트코인 투자
c = c.replace("\ube44\ud2b8\ucf54\uc778", "Bitcoin")  # 비트코인
c = c.replace("\uc774\ub354\ub9ac\uc6c0", "Ethereum")  # 이더리움
with open("tests/unit/test_knowledge.py", "w", encoding="utf-8") as f:
    f.write(c)
print("test_knowledge.py: done")

# Verify
import re, glob
K = re.compile(r"[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]")
total = 0
for f in sorted(glob.glob("**/*.py", recursive=True)):
    content = open(f, encoding="utf-8", errors="replace").read()
    n = sum(1 for l in content.splitlines() if K.search(l))
    if n:
        total += n
        print(f"  {f}: {n} remaining")
print(f"Total Korean lines remaining: {total}")
