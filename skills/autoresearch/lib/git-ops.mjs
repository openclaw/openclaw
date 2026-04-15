// lib/git-ops.mjs
import simpleGit from 'simple-git';

export function createGitOps(repoDir) {
  const git = simpleGit(repoDir);

  return {
    async hasUncommittedChanges() {
      const s = await git.status();
      return !s.isClean();
    },

    async branchExists(name) {
      const { all } = await git.branch(['--list', name]);
      return all.includes(name);
    },

    async currentBranch() {
      const { current } = await git.branch();
      return current;
    },

    async createAutoBranch(dateStr) {
      const name = `autoresearch/${dateStr}`;
      if (await this.branchExists(name)) {
        throw new Error(`Branch ${name} already exists — resolve previous run first`);
      }
      await git.checkoutLocalBranch(name);
      return name;
    },

    async commitWin(message) {
      await git.add('./*');
      await git.commit(message);
    },

    async resetHard() {
      await git.reset(['--hard', 'HEAD']);
    },

    async squashMergeToMain(branchName) {
      const prior = (await git.branch()).current;
      await git.checkout('main');
      await git.merge(['--squash', branchName]);
      await git.commit(`autoresearch ${branchName.split('/')[1]}: approved`);
      await git.deleteLocalBranch(branchName, true);
      return prior;
    },

    async deleteBranch(branchName) {
      await git.checkout('main');
      await git.deleteLocalBranch(branchName, true);
    },
  };
}
